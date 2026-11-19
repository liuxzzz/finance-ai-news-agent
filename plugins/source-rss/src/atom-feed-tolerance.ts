import Parser from "rss-parser";

/**
 * rss-parser 3.13 `utils.getLink` reads `link.$.rel` for every Atom link.
 * A text, CDATA, whitespace, or empty `<link>` is a string (or an object
 * without `$`), so one such node rejects the whole feed with
 * `Cannot read properties of undefined (reading 'rel')`. RSS text links never
 * enter `getLink` and already parse. Attribute links, including
 * `<link rel="alternate">https://...</link>` with text in `_`, are left as
 * xml2js produced them.
 *
 * The same item walker calls `Date.toISOString` on a bare Atom `<published>`
 * or `<updated>` string. One unparseable value raises `Invalid time value`
 * and drops every entry. Strings that `Date` can parse stay untouched, as do
 * values stored under attributes (`<updated type="text">`), which this parser
 * does not pass to `toISOString`.
 */
interface AtomParserMethods {
  buildAtomFeed(this: unknown, xmlObj: unknown): unknown;
  parseItemAtom(this: unknown, entry: unknown): unknown;
}

let installed = false;

export function installAtomFeedTolerance(): void {
  if (installed) {
    return;
  }

  const prototype = Parser.prototype as unknown as AtomParserMethods;

  if (
    typeof prototype.buildAtomFeed !== "function" ||
    typeof prototype.parseItemAtom !== "function"
  ) {
    throw new Error("rss-parser 3.13 Atom hooks are not available.");
  }

  const buildAtomFeed = prototype.buildAtomFeed;
  const parseItemAtom = prototype.parseItemAtom;
  installed = true;

  prototype.buildAtomFeed = function buildTolerantAtomFeed(xmlObj: unknown): unknown {
    normalizeAtomFeedLinks(xmlObj);
    return buildAtomFeed.call(this, xmlObj);
  };

  prototype.parseItemAtom = function parseTolerantAtomItem(entry: unknown): unknown {
    omitUnparseableAtomDates(entry);
    return parseItemAtom.call(this, entry);
  };
}

function normalizeAtomFeedLinks(xmlObj: unknown): void {
  if (!isRecord(xmlObj) || !isRecord(xmlObj.feed)) {
    return;
  }

  normalizeAtomLinkList(xmlObj.feed.link);

  if (!Array.isArray(xmlObj.feed.entry)) {
    return;
  }

  for (const entry of xmlObj.feed.entry) {
    if (isRecord(entry)) {
      normalizeAtomLinkList(entry.link);
    }
  }
}

function normalizeAtomLinkList(links: unknown): void {
  if (!Array.isArray(links)) {
    return;
  }

  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];

    if (typeof link === "string") {
      const href = link.trim();
      links[index] = href.length > 0 ? { $: { href } } : { $: {} };
      continue;
    }

    if (!isRecord(link) || isRecord(link.$)) {
      continue;
    }

    const text = typeof link._ === "string" ? link._.trim() : "";
    links[index] = {
      ...link,
      $: text.length > 0 ? { href: text } : {},
    };
  }
}

function omitUnparseableAtomDates(entry: unknown): void {
  if (!isRecord(entry)) {
    return;
  }

  if (atomTimestampWouldThrow(entry.published)) {
    delete entry.published;
  }

  if (atomTimestampWouldThrow(entry.updated)) {
    delete entry.updated;
  }
}

function atomTimestampWouldThrow(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }

  const first = value[0];

  if (typeof first !== "string" || first.length === 0) {
    return false;
  }

  return Number.isNaN(new Date(first).getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
