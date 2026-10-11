import json
import os
import re
import time

import pymupdf
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from google import genai
from google.genai import types
from pydantic import BaseModel
from rag import find_relevant_chunks, make_chunks

load_dotenv()
client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

# Main model first, backup model second
MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest"]
MAX_CHARS = 150000

# Websites allowed to talk to this server (comma-separated, set in the environment)
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]
MAX_PAPERS = 20

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

# One stored paper per visitor, keyed by session id (the oldest are dropped first)
PAPERS = {}

SUMMARY_PROMPT = """You are a research assistant. Read the research paper below and
return a structured summary as JSON with exactly these keys:

"tldr": a plain-language overview of the whole paper in 2 to 3 sentences, for a non-expert (always short, whatever the length instructions say)
"title": the title of the paper
"authors": the authors as a single string
"abstract": a short version of the abstract in 3-5 sentences
"problem_statement": what problem the paper tries to solve and why it matters
"methodology": how the authors approached the problem (methods, data, models)
"key_results": the most important findings, including numbers where available
"conclusion": the main conclusions and any limitations or future work
"suggested_questions": a list of 4 short questions that this document answers directly. Each question must be specific to this document's own content (use its real topics, names, methods, data or findings), and its answer must be clearly stated in the text. Never suggest generic questions, and never ask about anything the document does not cover. If the document is not a research paper (for example a business plan or a report), still base the questions on what it actually contains.

Use clear, simple language. Only use information found in the paper.

PAPER TEXT:
"""
DEPTH_NOTES = {
    "quick": "Keep every section very short: 1 to 2 sentences each.",
    "standard": "Keep every section clear and concise: 2 to 4 sentences each.",
    "detailed": "Make every section thorough: 5 to 8 sentences each, including specifics and numbers.",
}

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

def ndjson(payload):
    return json.dumps(payload) + "\n"


def ask_gemini_stream(prompt):
    """Yield the answer piece by piece. Retries and the backup model only
    apply until the first piece arrives."""
    for model in MODELS:
        for attempt in range(3):
            started = False
            try:
                for chunk in client.models.generate_content_stream(
                    model=model, contents=prompt
                ):
                    if chunk.text:
                        started = True
                        yield chunk.text
                return
            except Exception as error:
                print(f"{model} stream attempt {attempt + 1} failed: {error}")
                if started:
                    raise
                time.sleep(2 * (attempt + 1))

    raise HTTPException(
        status_code=503,
        detail="The AI is busy right now. Please try again in a moment.",
    )


def stream_answer(prompt, cited_pages):
    """Send the answer to the browser as newline-separated JSON messages."""
    buffer = ""
    decided = False

    def decide(text):
        stripped = text.lstrip()
        found = not stripped.startswith("NOT_FOUND")
        if not found:
            stripped = re.sub(r"^NOT_FOUND:?\s*", "", stripped)
        return found, stripped

    try:
        for piece in ask_gemini_stream(prompt):
            if decided:
                yield ndjson({"type": "token", "text": piece})
                continue

            buffer += piece
            # Wait for the first few characters to see if this is a NOT_FOUND answer
            if len(buffer.lstrip()) >= 10:
                decided = True
                found, text = decide(buffer)
                yield ndjson(
                    {"type": "meta", "found": found, "pages": cited_pages if found else []}
                )
                if text:
                    yield ndjson({"type": "token", "text": text})

        if not decided:
            found, text = decide(buffer)
            yield ndjson(
                {"type": "meta", "found": found, "pages": cited_pages if found else []}
            )
            if text:
                yield ndjson({"type": "token", "text": text})

        yield ndjson({"type": "done"})
    except Exception as error:
        detail = (
            error.detail
            if isinstance(error, HTTPException)
            else "Something went wrong while answering. Please try again."
        )
        yield ndjson({"type": "error", "detail": detail})

@app.get("/")
def home():
    return {"message": "Research Assistant is running"}


@app.post("/upload")
def upload(
    file: UploadFile = File(...),
    depth: str = Form("standard"),
    x_session_id: str = Header(default=""),
):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Please upload a PDF file")

    data = file.file.read()
    filename = file.filename
    session_id = x_session_id.strip()
    if not session_id:
        raise HTTPException(
            status_code=400, detail="Missing session. Please refresh the page."
        )   

    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(
            status_code=400,
            detail="This file is larger than 25 MB. Please upload a smaller PDF.",
        )

    def event(payload):
        return json.dumps(payload) + "\n"

    def process():
        try:
            yield event({"type": "step", "step": "extract"})
            try:
                doc = pymupdf.open(stream=data, filetype="pdf")
            except Exception:
                yield event({"type": "error", "detail": "Could not read this PDF file"})
                return

            pages = [page.get_text() for page in doc]
            text = "\n".join(pages)
            if len(text.strip()) < 200:
                yield event(
                    {
                        "type": "error",
                        "detail": "This PDF has no readable text. It may be a scanned document.",
                    }
                )
                return

            yield event({"type": "step", "step": "chunk"})
            chunks = make_chunks(pages)

            yield event({"type": "step", "step": "summary"})
            depth_note = DEPTH_NOTES.get(depth, DEPTH_NOTES["standard"])
            prompt = SUMMARY_PROMPT.replace("PAPER TEXT:", f"{depth_note}\n\nPAPER TEXT:")
            raw = ask_gemini(prompt + text[:MAX_CHARS], json_output=True)
            try:
                summary = json.loads(raw)
            except json.JSONDecodeError:
                yield event(
                    {"type": "error", "detail": "Could not understand the AI response. Try again."}
                )
                return

            PAPERS.pop(session_id, None)
            PAPERS[session_id] = {
                "filename": filename,
                "chunks": chunks,
                "summary": summary,
            }
            while len(PAPERS) > MAX_PAPERS:
                PAPERS.pop(next(iter(PAPERS)))

            yield event(
                {
                    "type": "done",
                    "result": {
                        "filename": filename,
                        "num_pages": len(pages),
                        "num_chunks": len(chunks),
                        "num_words": len(text.split()),
                        "summary": summary,
                    },
                }
            )
        except HTTPException as error:
            yield event({"type": "error", "detail": error.detail})
        except Exception:
            yield event(
                {"type": "error", "detail": "Something went wrong while reading this paper."}
            )

    return StreamingResponse(process(), media_type="application/x-ndjson")

class Question(BaseModel):
    question: str
    history: list[dict] = []


@app.post("/ask")
def ask(body: Question, x_session_id: str = Header(default="")):
    paper = PAPERS.get(x_session_id.strip())
    if not paper:
        raise HTTPException(
            status_code=400,
            detail="I don't have a paper for this session. The server may have restarted, so please upload your PDF again.",
        )

    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Please type a question.")

    recent = body.history[-6:]

    # Include the previous user question so follow-ups still find the right excerpts
    last_user = next(
        (m.get("text", "") for m in reversed(recent) if m.get("role") == "user"), ""
    )
    matches = find_relevant_chunks(f"{last_user} {question}", paper["chunks"], top_k=8)
    context = "\n\n".join(c["text"] for c in matches)

    # A short overview of the whole document, for broad questions
    summary = paper["summary"]
    overview = "\n".join(
        f"{label}: {summary[key]}"
        for key, label in [
            ("title", "Title"),
            ("tldr", "Overview"),
            ("abstract", "Abstract"),
            ("problem_statement", "Problem"),
            ("methodology", "Approach"),
            ("key_results", "Key results"),
            ("conclusion", "Conclusion"),
        ]
        if summary.get(key)
    )

    conversation = "\n".join(
        f"{'User' if m.get('role') == 'user' else 'Assistant'}: {m.get('text', '')}"
        for m in recent
    )

    prompt = f"""You are a friendly, knowledgeable research assistant. Answer the
question using ONLY the document overview and the excerpts below. For broad questions
(for example summarising, comparing or listing key points), combine the overview and
the excerpts. Only start your reply with NOT_FOUND: when neither of them contains
anything relevant to the question. If they contain partial information, answer with
what is there and say what is not covered.

Formatting rules:
- Write clear, well-organised markdown: short paragraphs, bullet lists, bold for key
  terms, and a markdown table whenever you compare items or list structured data.
- Never mention page numbers, excerpts, the overview or sources in your answer.
- Keep simple answers short (2 to 4 sentences). Give more detail only when asked.
- The question may come from speech recognition and contain misheard words, so use
  the document's context to work out what the user most likely meant.

EARLIER CONVERSATION:
{conversation or "(none yet)"}

DOCUMENT OVERVIEW:
{overview}

EXCERPTS:
{context}

QUESTION: {question}"""

    cited_pages = sorted({c["page"] for c in matches[:4]})
    return StreamingResponse(
        stream_answer(prompt, cited_pages), media_type="application/x-ndjson"
    )