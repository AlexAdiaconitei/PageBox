/*
 * Longshore — the router.
 *
 * An ES module, loaded with `type="module"`, which is one more thing for the host to get
 * right: it has to arrive as `text/javascript` or the browser refuses to run it.
 *
 * This file resolves to a real object, so the SPA fallback never sees it. That is the part
 * hosts get wrong when they implement the fallback as "serve index.html for everything":
 * the asset requests start coming back as HTML and the app breaks in silence.
 */

const READING = {
	queue: [
		{ title: 'The Mundanity of Excellence', source: 'Daniel F. Chambliss', mins: 34 },
		{
			title: 'A Rational Design Process: How and Why to Fake It',
			source: 'Parnas & Clements',
			mins: 41
		},
		{ title: 'Notes on the Synthesis of Form, ch. 1–3', source: 'Christopher Alexander', mins: 96 },
		{ title: 'What Colour Are Your Bits?', source: 'Matthew Skala', mins: 18 },
		{ title: 'The Cathedral of Computation', source: 'Ian Bogost', mins: 14 }
	],
	later: [
		{ title: 'Seeing Like a State, part II', source: 'James C. Scott', mins: 210 },
		{
			title: 'On the Criteria To Be Used in Decomposing Systems',
			source: 'D. L. Parnas',
			mins: 28
		},
		{ title: 'The Grug Brained Developer', source: 'grugbrain.dev', mins: 22 }
	],
	archive: [
		{ title: 'Out of the Tar Pit', source: 'Moseley & Marks', mins: 88 },
		{ title: 'No Silver Bullet', source: 'Fred Brooks', mins: 26 },
		{ title: 'Programming as Theory Building', source: 'Peter Naur', mins: 31 }
	]
};

const BLURB = {
	queue: 'Next up. Ordered by the evening it would take, not by when it arrived.',
	later: 'The long ones. Saved for a train, a flight, or a Sunday nobody needs anything.',
	archive: 'Read. Kept because you will want to argue with them again.'
};

const view = document.getElementById('view');
const count = document.getElementById('count');
const links = [...document.querySelectorAll('[data-route]')];

/**
 * The route is the last path segment.
 *
 * That is what makes this work under any base path: the site is served from `/s/<slug>/`
 * and the app was never told so. Parsing the whole pathname would mean hard-coding the
 * prefix, which is the single most common reason a build works locally and 404s once it is
 * deployed somewhere with a base.
 */
function currentRoute() {
	const tail = location.pathname.replace(/\/+$/, '').split('/').pop() ?? '';
	return tail in READING ? tail : 'queue';
}

function render(route) {
	const items = READING[route];
	const longest = Math.max(...items.map((item) => item.mins));

	view.replaceChildren();

	const heading = document.createElement('h1');
	heading.textContent = route[0].toUpperCase() + route.slice(1);
	const blurb = document.createElement('p');
	blurb.className = 'blurb';
	blurb.textContent = BLURB[route];
	view.append(heading, blurb);

	const list = document.createElement('ul');
	list.className = 'items';

	for (const item of items) {
		const li = document.createElement('li');
		li.className = 'item';

		const title = document.createElement('h2');
		title.textContent = item.title;

		const mins = document.createElement('span');
		mins.className = 'mins';
		mins.textContent = `${item.mins} min`;

		const source = document.createElement('span');
		source.className = 'source';
		source.textContent = item.source;

		// Scaled against the longest item in *this* list, so each view is honest about its own
		// contents rather than against an absolute nobody can see.
		const measure = document.createElement('div');
		measure.className = 'measure';
		const fill = document.createElement('span');
		fill.style.width = `${Math.round((item.mins / longest) * 100)}%`;
		measure.appendChild(fill);

		li.append(title, mins, source, measure);
		list.appendChild(li);
	}

	view.appendChild(list);

	const total = items.reduce((sum, item) => sum + item.mins, 0);
	const hours = Math.floor(total / 60);
	count.textContent = `${items.length} pieces · ${hours ? `${hours}h ` : ''}${total % 60}m`;

	for (const link of links) {
		if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
		else link.removeAttribute('aria-current');
	}

	document.title = `${heading.textContent} — Longshore`;
}

/*
 * Same-document navigation, intercepted so the browser does not go back to the server for a
 * path the server has no file for. Modifier and middle clicks are left alone: those mean
 * "open this somewhere else", and the somewhere else needs a real request — which is
 * exactly the request the SPA fallback exists to answer.
 */
document.addEventListener('click', (event) => {
	const link = event.target instanceof Element ? event.target.closest('[data-route]') : null;
	if (!link) return;
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

	event.preventDefault();
	history.pushState({}, '', link.getAttribute('href'));
	render(link.dataset.route);
	view.focus();
});

addEventListener('popstate', () => render(currentRoute()));
render(currentRoute());
