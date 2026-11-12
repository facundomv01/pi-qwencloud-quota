import type { PiKeybindings, PiTui } from "./types.ts";

// Measure terminal cells rather than UTF-16 units, including wide CJK and emoji.
function cellWidth(char: string): number {
	if (/\p{Mark}|\p{Default_Ignorable_Code_Point}/u.test(char)) return 0;
	return /[\p{Extended_Pictographic}\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u.test(char) ? 2 : 1;
}

function widthOf(text: string): number {
	return Array.from(text).reduce((width, char) => width + cellWidth(char), 0);
}

function wrap(line: string, width: number): string[] {
	if (widthOf(line) <= width) return [line];
	const rows: string[] = [];
	let row = "";
	for (const word of line.trim().split(/\s+/u)) {
		if (!word) continue;
		if (row && widthOf(row) + 1 + widthOf(word) <= width) {
			row += ` ${word}`;
			continue;
		}
		if (row) rows.push(row);
		row = "";
		for (const char of word) {
			if (widthOf(row) + cellWidth(char) > width && row) {
				rows.push(row);
				row = "";
			}
			if (cellWidth(char) <= width) row += char;
		}
	}
	if (row || !rows.length) rows.push(row);
	return rows;
}

/** A bounded viewport keeps even long local breakdowns navigable. */
export function createQuotaModal(tui: PiTui, keys: PiKeybindings, done: () => void, summary: string) {
	let lines = summary.split("\n");
	const pageSize = 10;
	let offset = 0;
	return {
		render(width: number): string[] {
			const frameWidth = Math.max(5, width);
			const inner = frameWidth - 4;
			lines = summary.split("\n").flatMap((line) => wrap(line, inner));
			offset = Math.min(offset, Math.max(0, lines.length - pageSize));
			const frame = (text: string) => `│ ${text}${" ".repeat(Math.max(0, inner - widthOf(text)))} │`;
			const title = wrap("QwenCloud", inner)[0];
			const footer = wrap(`↑/↓ scroll · Esc close  ${offset + 1}–${Math.min(offset + pageSize, lines.length)}/${lines.length}`, inner)[0];
			return [
				`┌${"─".repeat(frameWidth - 2)}┐`,
				frame(title),
				`├${"─".repeat(frameWidth - 2)}┤`,
				...lines.slice(offset, offset + pageSize).map(frame),
				`├${"─".repeat(frameWidth - 2)}┤`,
				frame(footer),
				`└${"─".repeat(frameWidth - 2)}┘`,
			];
		},
		handleInput(data: string): void {
			if (keys.matches(data, "tui.select.cancel")) return done();
			if (keys.matches(data, "tui.select.down")) offset = Math.min(Math.max(0, lines.length - pageSize), offset + 1);
			else if (keys.matches(data, "tui.select.up")) offset = Math.max(0, offset - 1);
			else return;
			tui.requestRender();
		},
		invalidate(): void {},
	};
}
