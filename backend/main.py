import json
import os
import time

import pymupdf
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types
from pydantic import BaseModel
from rag import find_relevant_chunks, make_chunks

load_dotenv()
client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

# Main model first, backup model second
MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest"]
MAX_CHARS = 150000

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Holds the paper that is currently uploaded
PAPER = {}

SUMMARY_PROMPT = """You are a research assistant. Read the research paper below and
return a structured summary as JSON with exactly these keys:

"title": the title of the paper
"authors": the authors as a single string
"abstract": a short version of the abstract in 3-5 sentences
"problem_statement": what problem the paper tries to solve and why it matters
"methodology": how the authors approached the problem (methods, data, models)
"key_results": the most important findings, including numbers where available
"conclusion": the main conclusions and any limitations or future work
"suggested_questions": a list of 4 short, interesting questions a reader could ask about this paper

Use clear, simple language. Only use information found in the paper.

PAPER TEXT:
"""


def ask_gemini(prompt, json_output=False):
    """Send a prompt to Gemini. Retries, then switches to the backup model."""
    config = None
    if json_output:
        config = types.GenerateContentConfig(response_mime_type="application/json")

    for model in MODELS:
        for attempt in range(3):
            try:
                response = client.models.generate_content(
                    model=model, contents=prompt, config=config
                )
                return response.text
            except Exception as error:
                print(f"{model} attempt {attempt + 1} failed: {error}")
                time.sleep(2 * (attempt + 1))

    raise HTTPException(
        status_code=503,
        detail="The AI is busy right now. Please try again in a moment.",
    )


@app.get("/")
def home():
    return {"message": "Research Assistant is running"}


@app.post("/upload")
def upload(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Please upload a PDF file")

    data = file.file.read()

    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read this PDF file")

    pages = [page.get_text() for page in doc]
    text = "\n".join(pages)

    if len(text.strip()) < 200:
        raise HTTPException(
            status_code=400,
            detail="This PDF has no readable text. It may be a scanned document.",
        )

    raw = ask_gemini(SUMMARY_PROMPT + text[:MAX_CHARS], json_output=True)

    try:
        summary = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=500, detail="Could not understand the AI response. Try again."
        )

    PAPER.clear()
    chunks = make_chunks(pages)
    PAPER.update({"filename": file.filename, "chunks": chunks, "summary": summary})
    return {
        "filename": file.filename,
        "num_pages": len(pages),
        "num_chunks": len(chunks),
        "summary": summary,
    }

class Question(BaseModel):
    question: str
    history: list[dict] = []


@app.post("/ask")
def ask(body: Question):
    if not PAPER:
        raise HTTPException(status_code=400, detail="Please upload a paper first.")

    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Please type a question.")

    recent = body.history[-6:]

    # Include the previous user question so follow-ups still find the right excerpts
    last_user = next(
        (m.get("text", "") for m in reversed(recent) if m.get("role") == "user"), ""
    )
    matches = find_relevant_chunks(f"{last_user} {question}", PAPER["chunks"])
    context = "\n\n".join(f"[Page {c['page']}]\n{c['text']}" for c in matches)

    conversation = "\n".join(
        f"{'User' if m.get('role') == 'user' else 'Assistant'}: {m.get('text', '')}"
        for m in recent
    )

    prompt = f"""You are a friendly research assistant having a spoken conversation
about a paper. Answer using ONLY the excerpts below. If the answer is not in the
excerpts, say the paper does not seem to cover it. Your answer will be read aloud,
so reply in 2 to 4 short plain sentences, with no bullet points, asterisks or
markdown. Mention page numbers naturally, like "on page 3".

EARLIER CONVERSATION:
{conversation or "(none yet)"}

EXCERPTS:
{context}

QUESTION: {question}"""

    answer = ask_gemini(prompt)
    pages = sorted({c["page"] for c in matches})
    return {"answer": answer, "pages": pages}