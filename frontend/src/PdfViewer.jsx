import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

// [zoom multiplier, label] - 1 means "fit the panel width"
const ZOOMS = [
  [0.75, "75%"],
  [1, "Fit width"],
  [1.25, "125%"],
  [1.5, "150%"],
  [2, "200%"],
];

export default function PdfViewer({ data, page, jump }) {
  const [doc, setDoc] = useState(null);
  const [pageNum, setPageNum] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [loadError, setLoadError] = useState("");

  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const taskRef = useRef(null);

  // Load the PDF
  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setLoadError("");
    setPageNum(1);

    const task = pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)) });
    task.promise
      .then((pdf) => {
        if (!cancelled) setDoc(pdf);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Could not display this PDF.");
      });

    return () => {
      cancelled = true;
      task.destroy();
    };
  }, [data]);

  // Jump to a page when a citation is clicked
  useEffect(() => {
    if (doc && page) setPageNum(Math.min(Math.max(1, page), doc.numPages));
  }, [page, jump, doc]);

  useEffect(() => {
    setPageInput(String(pageNum));
    stageRef.current?.scrollTo({ top: 0 });
  }, [pageNum]);

  // Keep track of the panel width so "Fit width" works
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  // Draw the current page
  useEffect(() => {
    if (!doc || !width) return;
    let cancelled = false;

    (async () => {
      const pdfPage = await doc.getPage(pageNum);
      if (cancelled) return;

      const base = pdfPage.getViewport({ scale: 1 });
      const fit = (width - 32) / base.width;
      const scale = Math.max(0.1, fit * zoom);
      const dpr = window.devicePixelRatio || 1;
      const viewport = pdfPage.getViewport({ scale: scale * dpr });

      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;

      const task = pdfPage.render({
        canvasContext: canvas.getContext("2d"),
        viewport,
      });
      taskRef.current = task;
      try {
        await task.promise;
      } catch {
        /* a newer render replaced this one */
      }
    })();

    return () => {
      cancelled = true;
      taskRef.current?.cancel();
    };
  }, [doc, pageNum, zoom, width]);

  const total = doc ? doc.numPages : 0;
  const zoomIndex = ZOOMS.findIndex(([value]) => value === zoom);

  function go(n) {
    if (!doc) return;
    setPageNum(Math.min(Math.max(1, n), total));
  }

  function commitInput() {
    const n = parseInt(pageInput, 10);
    if (Number.isNaN(n)) setPageInput(String(pageNum));
    else go(n);
  }

  return (
    <div className="viewer">
      <div className="viewer-stage" ref={stageRef}>
        {loadError && <p className="viewer-msg">{loadError}</p>}
        {!doc && !loadError && <p className="viewer-msg">Loading PDF...</p>}
        <canvas
          ref={canvasRef}
          className="viewer-canvas"
          style={{ display: doc ? "block" : "none" }}
        />
      </div>

      <div className="viewer-bar">
        <button className="vbtn" onClick={() => go(pageNum - 1)} disabled={pageNum <= 1} title="Previous page">
          ▲
        </button>
        <button className="vbtn" onClick={() => go(pageNum + 1)} disabled={!doc || pageNum >= total} title="Next page">
          ▼
        </button>
        <span className="vpage">
          Page:
          <input
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={commitInput}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
          of {total}
        </span>
        <button
          className="vbtn"
          onClick={() => setZoom(ZOOMS[Math.max(0, zoomIndex - 1)][0])}
          disabled={zoomIndex <= 0}
          title="Zoom out"
        >
          −
        </button>
        <button
          className="vbtn"
          onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, zoomIndex + 1)][0])}
          disabled={zoomIndex >= ZOOMS.length - 1}
          title="Zoom in"
        >
          +
        </button>
        <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
          {ZOOMS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}