/**
 * Compiles catalog/tools.sdl → catalog/tools.json (cliToolsCatalog schema).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdlPath = process.argv[2] ?? join(root, "catalog", "tools.sdl");
const outPath = process.argv[3] ?? join(root, "catalog", "tools.json");

function stripComments(text) {
  return text.replace(/^\s*\/\/[^\n]*$/gm, "");
}

function unquote(s) {
  return s.replace(/\\"/g, '"');
}

function tagValues(block, name) {
  const t = block.rawTags?.find((x) => x.name === name);
  return t ? [...t.values] : [];
}

function parseTagLine(block, line) {
  const tagMatch = /^([a-zA-Z][a-zA-Z0-9]*)\s*/.exec(line);
  if (!tagMatch) return;
  const tagName = tagMatch[1];
  const rest = line.slice(tagMatch[0].length).trim();

  if (rest.startsWith('"""')) {
    const end = rest.indexOf('"""', 3);
    const content = end >= 0 ? rest.slice(3, end) : rest.slice(3);
    block.rawTags.push({ name: tagName, values: [content.trim()] });
    return;
  }

  const values = [];
  const re = /"((?:\\.|[^"\\])*)"/g;
  let m;
  while ((m = re.exec(rest))) values.push(unquote(m[1]));
  if (values.length) block.rawTags.push({ name: tagName, values });
}

function findLineEnd(body, pos) {
  let i = pos;
  while (i < body.length) {
    if (body[i] === '"') {
      i++;
      if (body[i] === '"' && body[i + 1] === '"') {
        i += 3;
        while (i < body.length && !(body[i] === '"' && body[i + 1] === '"' && body[i + 2] === '"')) i++;
        i += 3;
        continue;
      }
      while (i < body.length && body[i] !== '"') {
        if (body[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (body[i] === "{") break;
    if (body[i] === "\n") {
      i++;
      break;
    }
    i++;
  }
  return i;
}

function parseBody(block, body) {
  let pos = 0;
  while (pos < body.length) {
    while (pos < body.length && /\s/.test(body[pos])) pos++;
    if (pos >= body.length) break;

    const nmMatch = /^([a-zA-Z][a-zA-Z0-9]*)/.exec(body.slice(pos));
    if (!nmMatch) break;
    const nm = nmMatch[1];
    let p = pos + nm.length;
    while (p < body.length && /\s/.test(body[p])) p++;

    if (body[p] === "{") {
      const sub = parseBlock(body.slice(pos), 0);
      pos = pos + sub.end;
      if (!block.children[nm]) block.children[nm] = [];
      block.children[nm].push(sub.block);
      continue;
    }

    const lineEnd = findLineEnd(body, pos);
    const line = body.slice(pos, lineEnd).trim();
    pos = lineEnd;
    if (line) parseTagLine(block, line);
  }
}

function parseBlock(src, start) {
  let i = start;
  while (i < src.length && /\s/.test(src[i])) i++;
  const nameMatch = /^([a-zA-Z][a-zA-Z0-9]*)/.exec(src.slice(i));
  if (!nameMatch) throw new Error(`Expected block name at ${i}`);
  const name = nameMatch[1];
  i += name.length;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== "{") throw new Error(`Expected { after ${name} at ${i}`);
  i++;

  const bodyStart = i;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '"') {
      i++;
      if (src[i] === '"' && src[i + 1] === '"') {
        i += 3;
        while (i < src.length && !(src[i] === '"' && src[i + 1] === '"' && src[i + 2] === '"')) i++;
        i += 3;
        continue;
      }
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth > 0) i++;
  }

  const body = src.slice(bodyStart, i - 1);
  i++;
  const block = { name, rawTags: [], children: {} };
  parseBody(block, body);
  return { block, end: i };
}

function blockToObject(block) {
  const obj = {};
  for (const t of block.rawTags ?? []) {
    if (t.values.length === 1) obj[t.name] = t.values[0];
    else obj[t.name] = t.values;
  }
  return obj;
}

function parseMethod(block) {
  return blockToObject(block);
}

function parseTool(block) {
  const tool = blockToObject(block);
  tool.install = [];
  const installWrap = block.children.install?.[0];
  if (installWrap) {
    for (const m of installWrap.children.method ?? []) {
      tool.install.push(parseMethod(m));
    }
  }
  return tool;
}

function parseSdl(text) {
  const src = stripComments(text);
  const { block: rootBlock } = parseBlock(src, 0);
  const catalogRoot = rootBlock.children.cliToolsCatalog?.[0] ?? rootBlock;

  const versionVal = tagValues(catalogRoot, "version")[0];
  const catalog = {
    version: versionVal ? Number(versionVal) : 1,
    meta: {},
    contexts: [],
    tools: [],
  };

  const metaBlock = catalogRoot.children.meta?.[0];
  if (metaBlock) catalog.meta = blockToObject(metaBlock);

  const contextsWrap = catalogRoot.children.contexts?.[0];
  if (contextsWrap) {
    for (const ctx of contextsWrap.children.context ?? []) {
      catalog.contexts.push(blockToObject(ctx));
    }
  }

  const toolsWrap = catalogRoot.children.tools?.[0];
  if (toolsWrap) {
    for (const tool of toolsWrap.children.tool ?? []) {
      catalog.tools.push(parseTool(tool));
    }
  }

  return catalog;
}

const catalog = parseSdl(readFileSync(sdlPath, "utf8"));
writeFileSync(outPath, JSON.stringify(catalog, null, 2) + "\n");
console.log(`Wrote ${outPath} (${catalog.tools.length} tools, ${catalog.contexts.length} contexts)`);
