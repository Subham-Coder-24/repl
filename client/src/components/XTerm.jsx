import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/**
 * Turns keystrokes into whole lines (with local echo). Used when the other end
 * is a plain pipe rather than a TTY — e.g. the stdin of a running program.
 */
function lineEditor(term, send) {
  let buffer = '';
  return (data) => {
    if (data.startsWith('\x1b')) return; // ignore arrow keys and other escape sequences
    for (const ch of data) {
      if (ch === '\r') {
        term.write('\r\n');
        send(`${buffer}\n`);
        buffer = '';
      } else if (ch === '\x7f' || ch === '\b') {
        if (buffer) {
          buffer = buffer.slice(0, -1);
          term.write('\b \b');
        }
      } else if (ch === '\x03') {
        term.write('^C\r\n');
        buffer = '';
      } else if (ch >= ' ') {
        buffer += ch;
        term.write(ch);
      }
    }
  };
}

/**
 * xterm.js bound to a socket.io channel.
 * - outputEvent: server -> terminal text
 * - send(data): called with user input (raw keystrokes, or whole lines if lineMode)
 * - onReady(term): called on every (re)connect with the sized terminal
 */
const XTerm = forwardRef(function XTerm(
  { socket, outputEvent, send, lineMode = false, convertEol = false, onReady, onResize },
  ref,
) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const props = useRef({});
  props.current = { send, lineMode, onReady, onResize };

  useImperativeHandle(ref, () => ({
    clear: () => termRef.current?.reset(),
    focus: () => termRef.current?.focus(),
  }));

  useEffect(() => {
    const term = new Terminal({
      convertEol,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Consolas, "Cascadia Mono", monospace',
      theme: { background: '#0e1117', foreground: '#d6deeb', cursor: '#82aaff' },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    termRef.current = term;

    // Copy / paste, like Windows Terminal: Ctrl+C copies when text is selected (otherwise it is
    // the usual interrupt), Ctrl+V pastes, right-click copies the selection or pastes.
    const copySelection = () => {
      const text = term.getSelection();
      if (!text) return false;
      navigator.clipboard?.writeText(text).catch(() => {});
      return true;
    };
    const pasteClipboard = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) term.paste(text);
      } catch {
        /* clipboard permission denied — Ctrl+V still works */
      }
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'c' && term.hasSelection()) {
        copySelection();
        return false; // do not send ^C to the program
      }
      return true; // Ctrl+V and everything else: default handling (xterm pastes natively)
    });
    const onContextMenu = (e) => {
      e.preventDefault();
      if (term.hasSelection()) {
        copySelection();
        term.clearSelection();
      } else {
        pasteClipboard();
      }
    };
    containerRef.current.addEventListener('contextmenu', onContextMenu);
    const container = containerRef.current;

    const safeFit = () => {
      const el = containerRef.current;
      if (el && el.clientWidth > 0 && el.clientHeight > 0) fit.fit();
    };
    safeFit();

    const editLine = lineEditor(term, (line) => props.current.send?.(line));
    const dataSub = term.onData((data) =>
      props.current.lineMode ? editLine(data) : props.current.send?.(data),
    );
    const resizeSub = term.onResize(({ cols, rows }) => props.current.onResize?.(cols, rows));

    const observer = new ResizeObserver(() => requestAnimationFrame(safeFit));
    observer.observe(containerRef.current);

    const write = (d) => term.write(d);
    const ready = () => props.current.onReady?.(term);
    socket.on(outputEvent, write);
    socket.on('connect', ready);
    if (socket.connected) ready();

    return () => {
      socket.off(outputEvent, write);
      socket.off('connect', ready);
      observer.disconnect();
      container.removeEventListener('contextmenu', onContextMenu);
      dataSub.dispose();
      resizeSub.dispose();
      term.dispose();
    };
  }, [socket, outputEvent, convertEol]);

  return <div className="xterm-container" ref={containerRef} />;
});

export default XTerm;
