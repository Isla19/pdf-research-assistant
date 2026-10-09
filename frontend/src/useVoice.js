import { useEffect, useRef, useState } from "react";

const Recognition =
  typeof window !== "undefined" &&
  (window.SpeechRecognition || window.webkitSpeechRecognition);

export const voiceSupported = Boolean(Recognition) && "speechSynthesis" in window;

// How long to wait after the last spoken word before sending the question
const SILENCE_MS = 3000;

// Prefer the nicer-sounding English voices when the browser has them
function pickVoice() {
  const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  return (
    voices.find((v) => /natural/i.test(v.name)) ||
    voices.find((v) => /google/i.test(v.name)) ||
    voices[0] ||
    null
  );
}

export default function useVoice(onQuestion) {
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | listening | thinking | speaking
  const [heard, setHeard] = useState("");
  const [error, setError] = useState("");

  const activeRef = useRef(false);
  const modeRef = useRef("idle");
  const recRef = useRef(null);
  const speakIdRef = useRef(0);
  const textRef = useRef("");
  const timerRef = useRef(null);
  const onQuestionRef = useRef(onQuestion);

  useEffect(() => {
    onQuestionRef.current = onQuestion;
  });

  function setMode(mode) {
    modeRef.current = mode;
    setStatus(mode);
  }

  function clearSpeech() {
    clearTimeout(timerRef.current);
    textRef.current = "";
    setHeard("");
  }

  // Runs after the user has been silent for SILENCE_MS
  function finish() {
    clearTimeout(timerRef.current);
    if (!activeRef.current || modeRef.current !== "listening") return;

    const text = textRef.current.trim();
    clearSpeech();
    if (!text) return;

    setMode("thinking");
    try {
      recRef.current?.abort();
    } catch {
      /* nothing to stop */
    }
    onQuestionRef.current(text);
  }

  function listen() {
    if (!activeRef.current) return;

    const rec = new Recognition();
    rec.lang = "en-GB";
    rec.interimResults = true;
    rec.continuous = true;

    // Words from an earlier session, in case the browser restarted listening
    const before = textRef.current;

    rec.onresult = (event) => {
      let said = "";
      for (let i = 0; i < event.results.length; i++) {
        said += event.results[i][0].transcript + " ";
      }
      textRef.current = `${before} ${said}`.replace(/\s+/g, " ").trim();
      setHeard(textRef.current);

      // Every new word restarts the countdown
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(finish, SILENCE_MS);
    };

    rec.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      const messages = {
        "not-allowed": "Microphone access is blocked. Click the lock icon in the address bar, allow the microphone, and try again.",
        "service-not-allowed": "Microphone access is blocked. Click the lock icon in the address bar, allow the microphone, and try again.",
        "audio-capture": "No microphone was found on this device.",
        network: "Speech recognition needs an internet connection.",
      };
      setError(messages[event.error] || `Voice error: ${event.error}`);
      stop();
    };

    // If the browser stopped listening on its own, start again
    rec.onend = () => {
      if (activeRef.current && modeRef.current === "listening") {
        setTimeout(listen, 300);
      }
    };

    recRef.current = rec;
    setMode("listening");
    try {
      rec.start();
    } catch {
      /* already started */
    }
  }

  function speak(text) {
    if (!activeRef.current || !text) return;

    clearSpeech();
    setMode("speaking");
    try {
      recRef.current?.abort();
    } catch {
      /* nothing to stop */
    }

    const synth = window.speechSynthesis;
    synth.cancel();

    const id = ++speakIdRef.current;
    const sentences = (text.match(/[^.!?]+[.!?]*/g) || [text])
      .map((s) => s.trim())
      .filter(Boolean);
    const voice = pickVoice();

    sentences.forEach((sentence, i) => {
      const utterance = new SpeechSynthesisUtterance(sentence);
      utterance.lang = "en-US";
      if (voice) utterance.voice = voice;
      const isLast = i === sentences.length - 1;
      const done = () => {
        if (isLast && id === speakIdRef.current && activeRef.current) listen();
      };
      utterance.onend = done;
      utterance.onerror = done;
      synth.speak(utterance);
    });
  }

  function start() {
    if (!voiceSupported) return;
    setError("");
    clearSpeech();
    activeRef.current = true;
    setActive(true);
    listen();
  }

  function stop() {
    activeRef.current = false;
    speakIdRef.current += 1;
    clearSpeech();
    setActive(false);
    setMode("idle");
    try {
      recRef.current?.abort();
    } catch {
      /* nothing to stop */
    }
    window.speechSynthesis.cancel();
  }

  useEffect(() => stop, []);

  return { active, status, heard, error, start, stop, speak };
}