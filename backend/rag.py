import math
import re
from collections import Counter

def make_chunks(pages, chunk_size=1000, overlap=200):
    """Split the paper into overlapping chunks and remember each page number."""
    chunks = []
    for page_number, page_text in enumerate(pages, start=1):
        text = " ".join(page_text.split())
        start = 0
        while start < len(text):
            piece = text[start : start + chunk_size]
            if len(piece.strip()) > 50:
                chunks.append({"page": page_number, "text": piece})
            start += chunk_size - overlap
    return chunks

STOP_WORDS = {
    "the", "a", "an", "is", "are", "was", "were", "of", "in", "on", "for", "to",
    "and", "or", "what", "which", "who", "how", "why", "does", "do", "did",
    "this", "that", "paper", "with", "by", "as", "it", "be", "from", "at",
}


def tokenize(text):
    words = re.findall(r"[a-z0-9]+", text.lower())
    return [w for w in words if w not in STOP_WORDS and len(w) > 1]


def find_relevant_chunks(question, chunks, top_k=4):
    """Return the chunks that best match the question."""
    query_words = set(tokenize(question))
    counts_per_chunk = [Counter(tokenize(c["text"])) for c in chunks]
    total = len(chunks)

    scores = []
    for counts in counts_per_chunk:
        score = 0
        for word in query_words:
            if counts[word]:
                chunks_with_word = sum(1 for c in counts_per_chunk if word in c)
                rarity = math.log(1 + total / chunks_with_word)
                score += rarity * (1 + math.log(counts[word]))
        scores.append(score)

    best = sorted(range(total), key=lambda i: scores[i], reverse=True)[:top_k]
    matches = [chunks[i] for i in best if scores[i] > 0]
    return matches or chunks[:top_k]