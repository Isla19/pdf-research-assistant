import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import PdfViewer from "./PdfViewer";
import useVoice, { voiceSupported } from "./useVoice";
import "./App.css";
import logo from "./assets/logo.png";

const API = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

// Each browser tab gets its own id, so visitors don't share papers
function getSessionId() {
  let id = sessionStorage.getItem("session");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("session", id);
  }
  return id;
}
const SESSION_ID = getSessionId();

const SECTIONS = [
  ["abstract", "Abstract"],
  ["problem_statement", "Problem Statement"],
  ["methodology", "Methodology"],
  ["key_results", "Key Results"],
  ["conclusion", "Conclusion"],
];

const DEPTHS = [
  ["quick", "Quick", "1 to 2 sentences per section"],
  ["standard", "Standard", "A clear, balanced overview"],
  ["detailed", "Detailed", "In-depth, with key numbers"],
];

const FEATURES = [
  ["📑", "Structured summary", "Abstract, problem, methodology, results and conclusion in clean cards."],
  ["💬", "Chat with citations", "Ask anything. Sources are one click away under every answer."],
  ["📄", "Side-by-side PDF", "Open a source and the PDF jumps straight to that page."],
  ["🎙", "Voice conversation", "Talk to your paper and hear the answer while you read it."],
  ["💡", "Suggested questions", "One-tap starter questions generated from your paper."],
  ["🎚", "Choose your detail", "Pick a quick, standard or detailed summary before you upload."],
];

const STEPS = [
  ["upload", "Uploading file"],
  ["extract", "Extracting text"],
  ["chunk", "Splitting into sections"],
  ["summary", "Building summary"],
];

// Lets tables scroll sideways inside a chat bubble
const MD_COMPONENTS = {
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
};

// ---------- Helpers ----------
function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function friendlyError(err) {
  return err.message === "Failed to fetch"
    ? "Cannot reach the server. Is the backend running?"
    : err.message;
}

// The server sends one JSON message per line; call onMessage for each one
async function readStream(res, onMessage) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (line.trim()) onMessage(JSON.parse(line));
    }
  }
}

// Turn a markdown answer into plain sentences that sound fine when spoken
function toSpeech(markdown) {
  const hasTable = /^\s*\|.*\|\s*$/m.test(markdown);
  let text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  text = text
    .split("\n")
    .filter((line) => !/^\s*\|/.test(line))
    .map((line) =>
      line
        .replace(/[*_`#>~]/g, "")
        .replace(/^\s*[-+]\s+/, "")
        .replace(/^\s*\d+\.\s+/, "")
        .trim()
    )
    .filter(Boolean)
    .map((line) => (/[.!?:]$/.test(line) ? line : `${line}.`))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (hasTable) text += " I've put a table in the chat.";
  return text;
}

function ProgressSteps({ step }) {
  const index = Math.max(0, STEPS.findIndex(([key]) => key === step));
  const percent = Math.round(((index + 0.5) / STEPS.length) * 100);

  return (
    <div className="progress">
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <ul className="progress-steps">
        {STEPS.map(([key, label], i) => (
          <li key={key} className={i < index ? "done" : i === index ? "active" : ""}>
            <span className="progress-mark">{i < index ? "✓" : i === index ? "●" : "○"}</span>
            {label}
            {i === index ? "..." : ""}
          </li>
        ))}
      </ul>
      <p className="progress-note">The summary step can take 10 to 30 seconds.</p>
    </div>
  );
}

export default function App() {
  // Paper and upload
  const [paper, setPaper] = useState(null);
  const [pdfData, setPdfData] = useState(null);
  const [fileInfo, setFileInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState("");
  const [depth, setDepth] = useState("standard");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");

  // Chat
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const chatBoxRef = useRef(null);
  const voice = useVoice((text) => askQuestion(text));

  // Layout
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "dark");
  const [showPdf, setShowPdf] = useState(false);
  const [tab, setTab] = useState("summary");
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfJump, setPdfJump] = useState(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  // Keep the newest message in view inside the chat box
  useEffect(() => {
    const box = chatBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages, asking, tab, showPdf]);

  function startVoice() {
    setTab("chat");
    voice.start();
  }

  // Open the PDF and jump to a page
  function openPdfAt(page) {
    setPdfPage(page);
    setPdfJump((n) => n + 1);
    setShowPdf(true);
  }

  function toggleSources(index) {
    setMessages((prev) =>
      prev.map((m, i) => (i === index ? { ...m, sourcesOpen: !m.sourcesOpen } : m))
    );
  }

  function startOver() {
    voice.stop();
    setPaper(null);
    setPdfData(null);
    setMessages([]);
    setError("");
    setShowPdf(false);
    setTab("summary");
  }

  async function uploadFile(file) {
    setLoading(true);
    setStep("upload");
    voice.stop();
    setError("");
    setPaper(null);
    setPdfData(null);
    setMessages([]);
    setPdfPage(1);
    setShowPdf(false);
    setTab("summary");

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("depth", depth);
      const res = await fetch(`${API}/upload`, {
        method: "POST",
        headers: { "X-Session-Id": SESSION_ID },
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || "Upload failed");
      }

      let result = null;
      await readStream(res, (msg) => {
        if (msg.type === "step") setStep(msg.step);
        else if (msg.type === "error") throw new Error(msg.detail);
        else if (msg.type === "done") result = msg.result;
      });

      if (!result) throw new Error("The upload ended unexpectedly. Please try again.");

      setPdfData(await file.arrayBuffer());
      setPaper(result);
      setFileInfo({ size: file.size, uploadedAt: new Date() });
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
      setStep("");
    }
  }

  function handleFileInput(event) {
    const file = event.target.files[0];
    event.target.value = "";
    if (file) uploadFile(file);
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Please drop a PDF file.");
      return;
    }
    uploadFile(file);
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

    let answer = "";
    let started = false;

    // Change the newest message while the answer streams in
    const updateLast = (changes) =>
      setMessages((prev) => {
        if (prev.length === 0) return prev;
        const copy = [...prev];
        copy[copy.length - 1] = { ...copy[copy.length - 1], ...changes };
        return copy;
      });

    try {
      const res = await fetch(`${API}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Id": SESSION_ID },
        body: JSON.stringify({ question, history }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || "Something went wrong");
      }

      await readStream(res, (msg) => {
        if (msg.type === "meta") {
          started = true;
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              text: "",
              pages: msg.pages,
              notFound: !msg.found,
              streaming: true,
              sourcesOpen: false,
            },
          ]);
        } else if (msg.type === "token") {
          answer += msg.text;
          updateLast({ text: answer.trimStart() });
        } else if (msg.type === "error") {
          throw new Error(msg.detail);
        } else if (msg.type === "done") {
          updateLast({ streaming: false });
          voice.speak(toSpeech(answer));
        }
      });
    } catch (err) {
      if (started) updateLast({ streaming: false });
      setMessages((prev) => [
        ...prev,
        { role: "assistant", isError: true, text: friendlyError(err) },
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
        <div className="landing-inner">
          <section className="hero">
            <div className="hero-copy">
              <div className="hero-brand">
                <img className="hero-logo" src={logo} alt="" />
                <span className="hero-brand-name">Research Assistant</span>
              </div>
              <h1>
                <span className="h1-line">Understand any research paper</span>
                <span className="h1-line accent-text">in seconds</span>
              </h1>
              <p className="subtitle">
                Upload a PDF to get a structured summary, then chat with it by typing or by
                voice.
              </p>
              <ul className="hero-points">
                <li>
                  <span className="tick">✓</span>Summarize papers instantly
                </li>
                <li>
                  <span className="tick">✓</span>Chat with answers and one-click sources
                </li>
                <li>
                  <span className="tick">✓</span>Talk to your paper by voice
                </li>
                <li>
                  <span className="tick">✓</span>Save hours of reading time
                </li>
              </ul>
              <p className="hero-footnote">Works best with text-based PDFs · Powered by Google Gemini</p>
            </div>

            <div className="hero-panel">
              {loading ? (
                <ProgressSteps step={step} />
              ) : (
                <div className="start-card">
                  <div className="start-step">
                    <span className="step-num">1</span>
                    <span className="step-label">Choose how detailed the summary should be</span>
                  </div>
                  <div className="depth-grid">
                    {DEPTHS.map(([key, label, hint]) => (
                      <button
                        key={key}
                        className={depth === key ? "depth-card active" : "depth-card"}
                        onClick={() => setDepth(key)}
                      >
                        <strong>{label}</strong>
                        <span>{hint}</span>
                      </button>
                    ))}
                  </div>

                  <div className="start-step">
                    <span className="step-num">2</span>
                    <span className="step-label">Upload your research paper</span>
                  </div>
                  <label
                    className={dragging ? "dropzone dragging" : "dropzone"}
                    onDragOver={(e) => e.preventDefault()}
                    onDragEnter={() => setDragging(true)}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
                    }}
                    onDrop={handleDrop}
                  >
                    <svg className="pdf-icon" viewBox="0 0 96 112" aria-hidden="true">
                      <path
                        className="pdf-page"
                        d="M8 8a8 8 0 0 1 8-8h44l28 28v76a8 8 0 0 1-8 8H16a8 8 0 0 1-8-8z"
                        strokeWidth="2"
                      />
                      <path className="pdf-fold" d="M60 0l28 28H68a8 8 0 0 1-8-8z" />
                      <rect x="0" y="50" width="70" height="34" rx="6" fill="#ef4444" />
                      <text className="pdf-text" x="35" y="74" textAnchor="middle">
                        pdf
                      </text>
                    </svg>
                    <strong className="drop-title">Upload your paper</strong>
                    <span className="drop-sub">Drop your PDF here</span>
                    <span className="drop-or">or</span>
                    <span className="cta">
                      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M12 16V5m0 0-4.5 4.5M12 5l4.5 4.5M5 19h14"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      Upload PDF to start
                    </span>
                    <input type="file" accept=".pdf" onChange={handleFileInput} hidden />
                  </label>
                  <p className="cta-note">
                    Text-based PDFs up to 25 MB. The text is sent to Google Gemini to write the
                    summary and answers.
                  </p>
                </div>
              )}

              {error && <p className="error">{error}</p>}
            </div>
          </section>

          <p className="preview-title">What you get (example)</p>
          <section className="preview" aria-hidden="true">
            <div className="mock">
              <div className="mock-tag">Your PDF</div>
              <div className="mock-title" />
              <div className="mock-line w90" />
              <div className="mock-line w80" />
              <div className="mock-line w90" />
              <div className="mock-line w60" />
              <div className="mock-line w80" />
              <div className="mock-line w70" />
            </div>
            <div className="mock-arrow">→</div>
            <div className="mock mock-summary">
              <div className="mock-tag">Your summary and chat</div>
              <div className="mock-section">
                <span>Problem statement</span>
                <div className="mock-line w90" />
                <div className="mock-line w70" />
              </div>
              <div className="mock-section">
                <span>Key results</span>
                <div className="mock-line w80" />
                <div className="mock-line w60" />
              </div>
              <div className="mock-chat">
                <div className="mock-q">What dataset did they use?</div>
                <div className="mock-a">
                  They evaluated on a public benchmark.<span className="mock-chip">Sources</span>
                </div>
              </div>
            </div>
          </section>

          <section className="features">
            {FEATURES.map(([icon, title, text]) => (
              <div className="feature-card" key={title}>
                <div className="feature-icon">{icon}</div>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            ))}
          </section>
        </div>
      </div>
    );
  }

  // ---------- Workspace (paper loaded) ----------
  const summary = paper.summary;
  const suggestions = summary?.suggested_questions || [];
  const readMinutes = Math.max(1, Math.round((paper.num_words || 0) / 200));
  const lastMessage = messages[messages.length - 1];

  const summaryPane = (
    <section className="pane">
      <h2 className="pane-title">Summary</h2>
      <div className="pane-scroll">
        <h2 className="paper-title">{summary.title}</h2>
        <p className="authors">{summary.authors}</p>

        {summary.tldr && (
          <div className="tldr">
            <span className="tldr-label">In short</span>
            <p>{summary.tldr}</p>
          </div>
        )}

        {SECTIONS.map(([key, label]) => (
          <div className="card" key={key}>
            <h3>{label}</h3>
            <p>{summary[key]}</p>
          </div>
        ))}
      </div>
    </section>
  );

  const chatPane = (
    <section className="pane">
      <h2 className="pane-title">Chat with the paper</h2>
      <div className="chat-area">
        <div className="chat-box" ref={chatBoxRef}>
          {messages.length === 0 && (
            <div className="chat-welcome">
              <p>Ask anything about this paper.</p>
              {suggestions.length > 0 && (
                <div className="suggestions">
                  {suggestions.map((q) => (
                    <button
                      key={q}
                      className="chip"
                      onClick={() => askQuestion(q)}
                      disabled={asking}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {messages.map((m, i) => (
            <div
              key={i}
              className={`bubble ${m.role}${m.isError ? " bubble-error" : ""}${
                m.notFound ? " bubble-notfound" : ""
              }`}
            >
              {m.notFound && <div className="notfound-label">Not found in this paper</div>}

              {m.role === "assistant" && !m.isError ? (
                <div className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                    {m.text}
                  </ReactMarkdown>
                </div>
              ) : (
                <p>{m.text}</p>
              )}
              {m.streaming && <span className="cursor" />}

              {m.pages && m.pages.length > 0 && !m.streaming && (
                <div className="sources">
                  <button className="sources-btn" onClick={() => toggleSources(i)}>
                    📎 Sources ({m.pages.length}) {m.sourcesOpen ? "▴" : "▾"}
                  </button>
                  {m.sourcesOpen &&
                    m.pages.map((p) => (
                      <button
                        className="page-chip"
                        key={p}
                        onClick={() => openPdfAt(p)}
                        title={`Open page ${p} in the PDF`}
                      >
                        Page {p}
                      </button>
                    ))}
                </div>
              )}
            </div>
          ))}

          {asking && !lastMessage?.streaming && (
            <div className="bubble assistant typing">Thinking...</div>
          )}
        </div>

        {voice.active && (
          <div className={`voice-bar ${voice.status}`}>
            <span className="voice-dot" />
            <span className="voice-text">
              {voice.status === "listening" &&
                (voice.heard ? `${voice.heard} ...` : "Listening... go ahead and ask")}
              {voice.status === "thinking" && "Thinking..."}
              {voice.status === "speaking" && "Speaking... the text is shown above"}
            </span>
            <button type="button" className="voice-end" onClick={() => voice.stop()}>
              End
            </button>
          </div>
        )}
        {voice.error && <p className="error">{voice.error}</p>}

        <form className="chat-input" onSubmit={handleSubmit}>
          {voiceSupported && (
            <button
              type="button"
              className={voice.active ? "mic active" : "mic"}
              title={voice.active ? "End voice conversation" : "Start voice conversation"}
              onClick={() => (voice.active ? voice.stop() : startVoice())}
            >
              🎙
            </button>
          )}
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Chat with the paper..."
            disabled={asking}
          />
          <button type="submit" className="send" disabled={asking || !input.trim()}>
            Send
          </button>
        </form>
        {!voiceSupported && <p className="voice-note">Voice works in Chrome or Edge</p>}
      </div>
    </section>
  );

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="brand-wrap">
          <img className="brand-logo" src={logo} alt="" />
          <h1 className="brand">Research Assistant</h1>
        </div>
        <div className="topbar-actions">
          <button className="btn" onClick={startOver}>
            + New PDF
          </button>
          <button className="btn" onClick={() => setShowPdf(!showPdf)}>
            {showPdf ? "Hide PDF" : "📄 Show PDF"}
          </button>
          {themeButton}
        </div>
      </header>

      <div className="infobar">
        <span className="file" title={paper.filename}>
          📄 {paper.filename}
        </span>
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
        {showPdf && pdfData && (
          <section className="viewer-col">
            <PdfViewer data={pdfData} page={pdfPage} jump={pdfJump} />
          </section>
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
    </div>
  );
}