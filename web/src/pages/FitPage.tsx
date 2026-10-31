import { type ReactNode, useEffect, useRef, useState } from "react";

/** A4の帳票を、置かれた幅に合わせて縮小して表示する（実際のA4サイズのまま描き、全体を縮める）。 */
export function FitPage({ children }: { children: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    const w = wrap.current, i = inner.current;
    if (!w || !i) return;
    const fit = () => {
      const s = Math.min(1, w.clientWidth / Math.max(1, i.offsetWidth));
      setScale(s);
      setHeight(i.offsetHeight * s);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(w); ro.observe(i);
    fit();
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={wrap} className="fit" style={{ height }}>
      <div ref={inner} className="fit-inner" style={{ transform: `scale(${scale})` }}>{children}</div>
    </div>
  );
}
