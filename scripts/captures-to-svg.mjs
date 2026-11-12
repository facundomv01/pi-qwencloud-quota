// Convert captured ANSI modal lines into an SVG screenshot where the modal
// FRAME is vector geometry (rounded rect + divider lines), never text glyphs.
// Frame alignment therefore cannot drift with font metrics — the exact defect
// the text-based captures had. Inner content is left-aligned monospace text.
import { readFileSync, writeFileSync } from "node:fs";

const BG = "#1A1218";
const FG = "#e8e3ea";
const BORDER = "#5b5368";
const CHAR = 8.4; // per-cell advance for the inner text
const LH = 19;
const PAD = 14;
const INNER_X = PAD + 12;

function parseAnsi(line) {
	const segs = [];
	let fg = null;
	let bold = false;
	let buf = "";
	const flush = () => {
		if (buf) segs.push({ text: buf, fg, bold });
		buf = "";
	};
	for (let i = 0; i < line.length; i++) {
		if (line[i] === "\x1b" && line[i + 1] === "[") {
			flush();
			const end = line.indexOf("m", i + 2);
			if (end === -1) {
				buf += line[i];
				continue;
			}
			const code = line.slice(i + 2, end);
			i = end;
			if (code === "0") {
				fg = null;
				bold = false;
			} else if (code === "1") bold = true;
			else if (code.startsWith("38;2;")) {
				const [, , r, g, b] = code.split(";");
				fg = `rgb(${r},${g},${b})`;
			} else if (code === "39") fg = null;
			continue;
		}
		buf += line[i];
	}
	flush();
	return segs;
}

const plain = (l) => l.replace(/\x1b\[[0-9;]*m/g, "");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Remove the leading "│ " and any trailing right-frame glyph + spaces.
function contentSegs(line) {
	const segs = parseAnsi(line);
	// drop leading box glyph + one space
	let cut = 2;
	const out = [];
	for (const seg of segs) {
		if (cut <= 0) {
			out.push({ ...seg });
			continue;
		}
		if (seg.text.length <= cut) {
			cut -= seg.text.length;
			continue;
		}
		out.push({ ...seg, text: seg.text.slice(cut) });
		cut = 0;
	}
	// strip trailing frame glyph and the spaces before it
	while (out.length) {
		const last = out[out.length - 1];
		last.text = last.text.replace(/[│┐┘┤]+$/, "").replace(/\s+$/, "");
		if (last.text.length === 0) out.pop();
		else break;
	}
	return out;
}

function toSvg(name, ansi) {
	const raw = ansi.replace(/\r/g, "").split("\n");
	while (raw.length && plain(raw[raw.length - 1]).trim() === "") raw.pop();

	const rows = raw.map((line) => {
		const p = plain(line).trimEnd();
		if (/^┌/.test(p)) {
			// The top edge carries the title between the corner and the dashes.
			const segs = parseAnsi(line);
			const titleSegs = contentSegs(line).map((s) => ({ ...s, text: s.text.replace(/─+$/, "").trimEnd() })).filter((s) => s.text.length > 0);
			return { kind: "top", title: titleSegs };
		}
		if (/^└/.test(p) || /^├─/.test(p)) return { kind: "divider" };
		if (!p.startsWith("│")) return { kind: "blank" };
		const segs = contentSegs(line);
		return { kind: "content", segs, text: segs.map((s) => s.text).join("") };
	});

	const maxCols = Math.max(1, ...rows.map((r) => (r.kind === "content" ? r.text.length : 0)));
	const innerW = Math.ceil(maxCols * CHAR) + 24;
	const width = innerW + PAD * 2;
	const height = rows.length * LH + PAD * 2;
	const x1 = PAD;
	const x2 = width - PAD;

	let body = `<rect x="${x1}" y="${PAD}" width="${x2 - x1}" height="${height - PAD * 2}" rx="8" fill="none" stroke="${BORDER}" stroke-width="1.5"/>\n`;
	let y = PAD + 14;
	for (const row of rows) {
		if (row.kind === "divider") {
			body += `<line x1="${x1}" y1="${(y - LH / 2).toFixed(1)}" x2="${x2}" y2="${(y - LH / 2).toFixed(1)}" stroke="${BORDER}" stroke-width="1"/>\n`;
		} else if (row.kind === "top") {
			// Title sits inside the frame top, left-aligned; the frame line stays whole.
			let x = INNER_X;
			for (const seg of row.title) {
				const fill = seg.fg ?? FG;
				const weight = seg.bold ? ' font-weight="700"' : "";
				body += `<text x="${x.toFixed(1)}" y="${y}" font-family="'Cascadia Mono','JetBrains Mono','Fira Code',Consolas,'DejaVu Sans Mono',monospace" font-size="13.5" fill="${fill}"${weight} xml:space="preserve">${esc(seg.text)}</text>`;
				x += seg.text.length * CHAR;
			}
			body += `<line x1="${x1}" y1="${(y + LH / 2).toFixed(1)}" x2="${x2}" y2="${(y + LH / 2).toFixed(1)}" stroke="${BORDER}" stroke-width="1"/>\n`;
		} else if (row.kind === "content") {
			let x = INNER_X;
			for (const seg of row.segs) {
				const fill = seg.fg ?? FG;
				const weight = seg.bold ? ' font-weight="700"' : "";
				body += `<text x="${x.toFixed(1)}" y="${y}" font-family="'Cascadia Mono','JetBrains Mono','Fira Code',Consolas,'DejaVu Sans Mono',monospace" font-size="13.5" fill="${fill}"${weight} xml:space="preserve">${esc(seg.text)}</text>`;
				x += seg.text.length * CHAR;
			}
		}
		y += LH;
	}

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="gentle-shell terminal: ${name} view of the pi-qwencloud-quota modal">
<rect width="100%" height="100%" rx="10" fill="${BG}"/>
${body}</svg>\n`;
}

import { existsSync } from "node:fs";
for (const name of ["loading", "overview", "breakdown"]) {
	const ansi = `docs/img/${name}.ansi`;
	if (!existsSync(ansi)) continue; // convert only freshly captured views
	writeFileSync(`docs/img/${name}.svg`, toSvg(name, readFileSync(ansi, "utf8")));
}
console.log("vector-frame svgs written");
