/**
 * Writes the binary assets for the Meridian 01 example.
 *
 * They are committed, not generated at deploy time — a fixture whose bytes change between
 * runs is a fixture you cannot compare. This script exists so the bytes are reproducible
 * and so anyone can see exactly what they are rather than trusting a blob in the repo.
 *
 *   node examples/03-assets-downloads/make-assets.mjs
 *
 * What each one is for, on the host side:
 *   .png   an image Content-Type, and a body large enough to ask for a byte range
 *   .pdf   an inline-viewable type that is not text and not an image
 *   .zip   the download case: application/zip, saved rather than rendered
 *   .bin   application/octet-stream, the fallback branch of the MIME table
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const here = dirname(fileURLToPath(import.meta.url));
const img = join(here, 'img');
const downloads = join(here, 'downloads');
mkdirSync(img, { recursive: true });
mkdirSync(downloads, { recursive: true });

/* --- PNG ------------------------------------------------------------------
 * Written by hand rather than pulled from a library: a PNG is a signature plus
 * length-prefixed, CRC'd chunks, and 40 lines of it beats a dependency for two images.
 */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(buf) {
	let c = 0xffffffff;
	for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const out = Buffer.alloc(8 + data.length + 4);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'ascii');
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

/** `shade(x, y)` returns [r, g, b] for each pixel. */
function png(width, height, shade) {
	// One filter byte (0 = none) per scanline, then RGB triples.
	const raw = Buffer.alloc(height * (1 + width * 3));
	let offset = 0;
	for (let y = 0; y < height; y++) {
		raw[offset++] = 0;
		for (let x = 0; x < width; x++) {
			const [r, g, b] = shade(x, y, width, height);
			raw[offset++] = r;
			raw[offset++] = g;
			raw[offset++] = b;
		}
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // truecolour
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}

// The hero: the board photographed against the dark cloth these things are always shot on,
// with the oscillator's beat rendered as interference. Deterministic, so it never changes.
writeFileSync(
	join(img, 'board-hero.png'),
	png(1200, 675, (x, y, w, h) => {
		const cx = (x / w - 0.5) * 2;
		const cy = (y / h - 0.5) * 2;
		const vignette = 1 - Math.min(1, (cx * cx + cy * cy) * 0.55);
		const beat = Math.sin(x / 14) * Math.sin(y / 22) * 0.5 + 0.5;
		const trace = Math.abs(Math.sin(x / 90 + y / 260)) > 0.985 ? 1 : 0;
		return [
			Math.round((10 + beat * 14 + trace * 190) * vignette),
			Math.round((22 + beat * 30 + trace * 210) * vignette),
			Math.round((34 + beat * 46 + trace * 190) * vignette)
		];
	})
);

// A detail shot of the oven-controlled oscillator can, warm against the cold board.
writeFileSync(
	join(img, 'ocxo-detail.png'),
	png(800, 800, (x, y, w, h) => {
		const dx = x / w - 0.5;
		const dy = y / h - 0.5;
		const r = Math.sqrt(dx * dx + dy * dy);
		const can = r < 0.34 ? 1 : 0;
		const rim = r > 0.32 && r < 0.35 ? 1 : 0;
		const heat = can * (1 - r * 1.6);
		return [
			Math.round(18 + heat * 210 + rim * 120),
			Math.round(26 + heat * 120 + rim * 90),
			Math.round(38 + heat * 40 + rim * 60)
		];
	})
);

/* --- PDF ------------------------------------------------------------------
 * A minimal one-page document. PDF is a text format until you add compression, so a
 * readable datasheet cover fits in a template with a byte-offset table.
 */
function pdf(lines) {
	const content = lines
		.map(([size, y, text]) => `BT /F1 ${size} Tf 62 ${y} Td (${text}) Tj ET`)
		.join('\n');
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
			'/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
	];

	let out = '%PDF-1.4\n';
	const offsets = [];
	objects.forEach((body, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});

	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, 'latin1');
}

writeFileSync(
	join(downloads, 'meridian-01-datasheet.pdf'),
	pdf([
		[26, 760, 'MERIDIAN 01'],
		[13, 736, 'GPS-disciplined clock, 10 MHz reference'],
		[11, 700, 'Holdover          1e-9 over 4 hours, OCXO warmed'],
		[11, 682, 'Acquisition       cold 12 min, warm 90 s'],
		[11, 664, 'Outputs           10 MHz sine, 1 PPS TTL, NMEA over USB'],
		[11, 646, 'Supply            9-15 V DC, 4.5 W steady, 11 W warming'],
		[11, 628, 'Antenna           SMA, 3.3 V bias, 25 m RG-174 supplied'],
		[11, 610, 'Board             100 x 80 mm, four layer, 1.6 mm'],
		[11, 574, 'Kit contents      board, OCXO, antenna, case files, no enclosure'],
		[11, 556, 'Assembly          through-hole only; SMD is pre-populated'],
		[10, 500, 'Revision C - see the changelog on the site for what moved.'],
		[10, 484, 'This page is a fixture. The clock is not real. The numbers are plausible.']
	])
);

/* --- ZIP + BIN ----------------------------------------------------------- */
const encoder = new TextEncoder();
writeFileSync(
	join(downloads, 'meridian-01-case.zip'),
	Buffer.from(
		zipSync(
			{
				'README.txt': encoder.encode(
					'Meridian 01 — enclosure files\n' +
						'=============================\n\n' +
						'base.scad     parametric, edit `wall` and re-render\n' +
						'lid.scad      press fit, 0.2 mm clearance\n' +
						'gasket.dxf    2 mm neoprene, cut or punch\n\n' +
						'Printed in PETG at 0.2 mm. PLA creeps at the temperature the OCXO\n' +
						'holds and the lid stops fitting after about a month.\n'
				),
				'base.scad': encoder.encode(
					'// Meridian 01 base — all dimensions in mm.\n' +
						'wall = 2.4;\nboard_x = 100;\nboard_y = 80;\nstandoff = 6;\n\n' +
						'module base() {\n  difference() {\n' +
						'    cube([board_x + wall * 2, board_y + wall * 2, 26]);\n' +
						'    translate([wall, wall, wall]) cube([board_x, board_y, 30]);\n' +
						'  }\n}\n\nbase();\n'
				),
				'lid.scad': encoder.encode(
					'// Press fit, 0.2 mm clearance. Vent slots over the OCXO can.\n' +
						'include <base.scad>\n\nlid_h = 4;\nvent = 1.6;\n'
				),
				'gasket.dxf': encoder.encode('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n')
			},
			{ level: 6 }
		)
	)
);

// Firmware: not text, not an image, no extension the MIME table knows — the
// application/octet-stream fallback, and the one people actually download.
const firmware = Buffer.alloc(96 * 1024);
for (let i = 0; i < firmware.length; i++) {
	firmware[i] = (i * 37 + Math.floor(i / 251) * 11) & 0xff;
}
firmware.write('MERIDIAN01-FW-1.4.2', 0, 'ascii');
writeFileSync(join(downloads, 'meridian-01-fw-1.4.2.bin'), firmware);

console.log('wrote img/ and downloads/');
