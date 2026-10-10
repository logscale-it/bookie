/**
 * Minimal namespace-stripping XML reader for e-invoice parsing.
 *
 * Why not DOMParser: it does not exist under `bun test` (and we add no
 * dependency). UBL and CII element local names are unambiguous inside the
 * paths we read, so prefixes are dropped and nodes are addressed by local-name
 * paths. ponytail: not a validating parser; no namespace URI check, no DTD.
 * DOCTYPE with ENTITY declarations is rejected (XXE / billion-laughs).
 */

export interface XmlNode {
  name: string; // local name, prefix stripped
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(cp);
      } catch {
        return m;
      }
    }
    return NAMED[e] ?? m;
  });
}

const local = (n: string) => n.slice(n.indexOf(":") + 1);

export function parseXml(xml: string): XmlNode {
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  if (/<!ENTITY/i.test(xml)) throw new Error("XML mit ENTITY-Deklaration wird nicht unterstützt");
  const tok =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>!?]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let m: RegExpExecArray | null;
  while ((m = tok.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += decode(m[6]);
    else if (m[3] !== undefined) {
      if (m[2]) {
        if (stack.length < 2 || stack[stack.length - 1].name !== local(m[3]))
          throw new Error(`Ungültiges XML: unerwartetes </${m[3]}>`);
        stack.pop();
      } else {
        const attrs: Record<string, string> = {};
        for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g))
          attrs[local(a[1])] = decode(a[3] ?? a[4] ?? "");
        const node: XmlNode = { name: local(m[3]), attrs, children: [], text: "" };
        top.children.push(node);
        if (!m[5]) stack.push(node);
      }
    }
  }
  if (stack.length !== 1 || root.children.length !== 1)
    throw new Error("Ungültiges XML: Struktur unvollständig");
  return root.children[0];
}

/** Direct children with the given local name. */
export const kids = (n: XmlNode | undefined, name: string): XmlNode[] =>
  n ? n.children.filter((c) => c.name === name) : [];

/** First node along a local-name path, e.g. `at(root, "A", "B")`. */
export function at(n: XmlNode | undefined, ...path: string[]): XmlNode | undefined {
  let cur = n;
  for (const p of path) {
    cur = cur?.children.find((c) => c.name === p);
    if (!cur) return undefined;
  }
  return cur;
}

/** Trimmed text of the node at `path`, or undefined. */
export function txt(n: XmlNode | undefined, ...path: string[]): string | undefined {
  const v = at(n, ...path)?.text.trim();
  return v ? v : undefined;
}
