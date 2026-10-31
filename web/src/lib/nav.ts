// 画面の行き先をURLのハッシュで表す（#project=<id> / #invoice=<id> / #doc=<id>）。どの画面からでも別のタブの詳細を開ける。
export type RouteKind = "project" | "invoice" | "doc";
export type Route = { kind: RouteKind; id: string } | null;

export const parseRoute = (): Route => {
  const m = /^#(project|invoice|doc)=([0-9a-f-]{36}|new)$/.exec(window.location.hash);
  return m ? { kind: m[1] as RouteKind, id: m[2] } : null;
};
export const go = (kind: RouteKind, id: string) => { window.location.hash = `${kind}=${id}`; };
export const clearRoute = () => { window.location.hash = ""; };
