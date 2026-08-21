/*
 * Tallow Press — the one script.
 *
 * Content-hashed like the stylesheet, and loaded with `defer` so it runs after the document
 * is parsed. Everything here is progressive: the swatch list and the estimate are additions
 * to a page that already reads without them, which is the only honest way to ship a script
 * to a page whose job is a phone number and an address.
 */
(function () {
	'use strict';

	// The stock list lives here rather than in the markup so the shelf is described once.
	// Real names from the Riso range — the palette of the site is the palette of the drums.
	const INKS = [
		{ name: 'Fluorescent Pink', code: 'F-PINK', hex: '#ff48b0' },
		{ name: 'Aqua', code: 'S-260', hex: '#00a2b0' },
		{ name: 'Yellow', code: 'S-231', hex: '#ffd200' },
		{ name: 'Bright Red', code: 'S-231R', hex: '#f15060' },
		{ name: 'Medium Blue', code: 'S-268', hex: '#3255a4' },
		{ name: 'Green', code: 'S-234', hex: '#00a95c' },
		{ name: 'Burgundy', code: 'S-262', hex: '#914e72' },
		{ name: 'Black', code: 'S-107', hex: '#101010' }
	];

	const shelf = document.getElementById('swatches');
	if (shelf) {
		for (const ink of INKS) {
			const item = document.createElement('li');
			item.className = 'swatch';
			// textContent rather than innerHTML: the list is data, and data does not get to
			// bring markup with it.
			const chip = document.createElement('span');
			chip.className = 'chip';
			chip.style.backgroundColor = ink.hex;
			const name = document.createElement('span');
			name.className = 'swatch-name';
			name.textContent = ink.name;
			const code = document.createElement('span');
			code.className = 'swatch-code';
			code.textContent = ink.code;
			item.append(chip, name, code);
			shelf.appendChild(item);
		}
	}

	// £18 setup per colour, then a per-sheet rate that falls with the run — which is how a
	// press actually prices, because the setup is the expensive part.
	const SETUP_PER_COLOUR = 18;

	function estimate({ sheets, colours, stock }) {
		const rate = sheets >= 300 ? 0.12 : sheets >= 100 ? 0.16 : 0.24;
		return SETUP_PER_COLOUR * colours + sheets * rate * colours * stock;
	}

	const form = document.getElementById('calc');
	const output = document.getElementById('estimate');
	if (!form || !output) return;

	const money = new Intl.NumberFormat('en-GB', {
		style: 'currency',
		currency: 'GBP',
		maximumFractionDigits: 0
	});

	function update() {
		const data = new FormData(form);
		const sheets = Number(data.get('sheets'));
		if (!Number.isFinite(sheets) || sheets <= 0) {
			output.textContent = '—';
			return;
		}
		output.textContent = money.format(
			estimate({
				sheets,
				colours: Number(data.get('colours')),
				stock: Number(data.get('stock'))
			})
		);
	}

	form.addEventListener('input', update);
	// A form on a page with no server has nothing to submit to; saying so beats a reload
	// that looks like the page broke.
	form.addEventListener('submit', (event) => event.preventDefault());
	update();
})();
