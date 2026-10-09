import { useEffect, useRef, useState } from "react";
import "./App.css";
import useVoice, { voiceSupported } from "./useVoice";

const API = "http://127.0.0.1:8000";

const SECTIONS = [
  ["abstract", "Abstract"],
  ["problem_statement", "Problem Statement"],
  ["methodology", "Methodology"],
  ["key_results", "Key Results"],
  ["conclusion", "Conclusion"],
];

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function App() {
  const [paper, setPaper] = useState(null);
  const [fileInfo, setFileInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "dark");

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const chatBoxRef = useRef(null);
  const voice = useVoice((text) => askQuestion(text));

  function startVoice() {
    setTab("chat");
    voice.start();
  }

  const [showPdf, setShowPdf] = useState(false);
  const [tab, setTab] = useState("summary");
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfJump, setPdfJump] = useState(0);
  const [pdfVersion, setPdfVersion] = useState(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  // Keep the newest message in view inside the chat box
  useEffect(() => {
    const box = chatBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages, asking, tab, showPdf]);

  // Open the PDF panel and jump to a page
  function openPdfAt(page) {
    setPdfPage(page);
    setPdfJump((n) => n + 1);
    setShowPdf(true);
  }

  async function handleUpload(event) {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;

    setLoading(true);
      voice.stop();
    setError("");
    setPaper(null);
    setMessages([]);
    setShowPdf(false);
    setTab("summary");
    setPdfPage(1);

    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${API}/upload`, { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Upload failed");
      setPaper(data);
      setFileInfo({ size: file.size, uploadedAt: new Date() });
      setPdfVersion((v) => v + 1);
    } catch (err) {
      setError(
        err.message === "Failed to fetch"
          ? "Cannot reach the server. Is the backend running?"
          : err.message
      );
    } finally {
      setLoading(false);
    }
  }

    async function askQuestion(text) {
    const question = text.trim();
    if (!question || asking) return;

    // Send the earlier conversation so follow-up questions make sense
    const history = messages
      .filter((m) => !m.isError)
      .map((m) => ({ role: m.role, text: m.text }));

    setMessages((prev) => [...prev, { role: "user", text: question }]);
    setInput("");
    setAsking(true);

    try {
      const res = await fetch(`${API}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Something went wrong");
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: data.answer,
          pages: data.pages,
          notFound: data.found === false,
        },
      ]);
      voice.speak(data.answer);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          isError: true,
          text:
            err.message === "Failed to fetch"
              ? "Cannot reach the server. Is the backend running?"
              : err.message,
        },
      ]);
      voice.speak("Sorry, something went wrong. Please try again.");
    } finally {
      setAsking(false);
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    askQuestion(input);
  }

  const themeButton = (
    <button className="btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
      {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
    </button>
  );

  // ---------- Start screen (no paper yet) ----------
  if (!paper) {
    return (
      <div className="landing">
        <div className="landing-top">{themeButton}</div>
        <div className="hero">
          <h1>Research Assistant</h1>
          <p className="subtitle">
            Upload a research paper to get a structured summary, then chat with it.
          </p>
          <label className="upload">
            {loading
              ? "Reading your paper... this can take up to a minute"
              : "Click to choose a PDF"}
            <input type="file" accept=".pdf" onChange={handleUpload} disabled={loading} hidden />
          </label>
          {error && <p className="error">{error}</p>}
          <div className="feature-row">
            <span className="feature-pill">Structured summary</span>
            <span className="feature-pill">Chat with citations</span>
            <span className="feature-pill">Side-by-side PDF</span>
          </div>
        </div>
      </div>
    );
  }

  // ---------- Workspace (paper loaded) ----------
  const suggestions = paper.summary?.suggested_questions || [];
  const readMinutes = Math.max(1, Math.round((paper.num_words || 0) / 200));

  const summaryPane = (
    <div className="summary-pane">
      <h2 className="paper-title">{paper.summary.title}</h2>
      <p className="authors">{paper.summary.authors}</p>
      {SECTIONS.map(([key, label]) => (
        <div className="card" key={key}>
          <h3>{label}</h3>
          <p>{paper.summary[key]}</p>
        </div>
      ))}
    </div>
  );

  const chatPane = (
    <section className="chat-pane">
      <div className="chat-head">
        <h2>Chat with the paper</h2>
        {voiceSupported ? (
          <button
            className={voice.active ? "btn btn-live" : "btn"}
            onClick={() => (voice.active ? voice.stop() : startVoice())}
          >
            {voice.active ? "⏹ End voice chat" : "🎙 Voice conversation"}
          </button>
        ) : (
          <span className="voice-note">Voice works in Chrome or Edge</span>
        )}
      </div>
      {voice.active && (
        <div className={`voice-bar ${voice.status}`}>
          <span className="voice-dot" />
          <span className="voice-text">
            {voice.status === "listening" &&
              (voice.heard ? `${voice.heard} ...` : "Listening... go ahead and ask")}
            {voice.status === "thinking" && "Thinking..."}
            {voice.status === "speaking" && "Speaking... the text is shown below"}
          </span>
        </div>
      )}
      {voice.error && <p className="error">{voice.error}</p>}

      {messages.length === 0 && suggestions.length > 0 && (
        <div className="suggestions">
          <p className="suggestions-label">Try asking:</p>
          {suggestions.map((q) => (
            <button key={q} className="chip" onClick={() => askQuestion(q)} disabled={asking}>
              {q}
            </button>
          ))}
        </div>
      )}

      <div className="chat-box" ref={chatBoxRef}>
        {messages.length === 0 && <p className="chat-empty">Ask anything about this paper.</p>}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`bubble ${m.role}${m.isError ? " bubble-error" : ""}${
              m.notFound ? " bubble-notfound" : ""
            }`}
          >
            {m.notFound && <div className="notfound-label">Not found in this paper</div>}
            <p>{m.text}</p>
            {m.pages && m.pages.length > 0 && (
              <div className="sources">
                Sources:
                {m.pages.map((p) => (
                  <button
                    className="page-chip"
                    key={p}
                    onClick={() => openPdfAt(p)}
                    title={`Open page ${p} in the PDF`}
                  >
                    p. {p}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {asking && <div className="bubble assistant typing">Thinking...</div>}
      </div>

      <form className="chat-input" onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your question..."
          disabled={asking}
        />
        <button type="submit" disabled={asking || !input.trim()}>
          Send
        </button>
      </form>
    </section>
  );

  return (
    <div className="workspace">
      <header className="topbar">
        <h1 className="brand">Research Assistant</h1>
        <div className="topbar-actions">
          <label className="btn">
            Upload new PDF
            <input type="file" accept=".pdf" onChange={handleUpload} disabled={loading} hidden />
          </label>
          <button className="btn" onClick={() => setShowPdf(!showPdf)}>
            {showPdf ? "Hide PDF" : "📄 Show PDF"}
          </button>
          {themeButton}
        </div>
      </header>

      <div className="infobar">
        <span className="file" title={paper.filename}>📄 {paper.filename}</span>
        <span>📑 {paper.num_pages} pages</span>
        {fileInfo && <span>💾 {formatSize(fileInfo.size)}</span>}
        <span>⏱ ~{readMinutes} min read</span>
        {fileInfo && (
          <span>
            🕒 Uploaded{" "}
            {fileInfo.uploadedAt.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
          </span>
        )}
      </div>

      <div className={`workspace-body${showPdf ? " with-pdf" : ""}`}>
        {showPdf && (
          <aside className="pdf-panel">
            <div className="pdf-header">
              <span>Original PDF · page {pdfPage}</span>
              <button onClick={() => setShowPdf(false)} title="Close">✕</button>
            </div>
            <iframe
              key={`${pdfVersion}-${pdfJump}`}
              title="Original PDF"
              src={`${API}/pdf?v=${pdfVersion}#page=${pdfPage}`}
            />
          </aside>
        )}

        <div className="assistant">
          {showPdf && (
            <div className="tabs">
              <button
                className={tab === "summary" ? "tab active" : "tab"}
                onClick={() => setTab("summary")}
              >
                Summary
              </button>
              <button
                className={tab === "chat" ? "tab active" : "tab"}
                onClick={() => setTab("chat")}
              >
                Chat
              </button>
            </div>
          )}
          <div className="columns">
            {(!showPdf || tab === "summary") && summaryPane}
            {(!showPdf || tab === "chat") && chatPane}
          </div>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
    </div>
  );
}