// Opens one visible and N hidden tabs on a page using S distinct SVG images, then samples
// each tab's renderer CPU every 10s and ends on a `repro:` verdict line
const { app, BrowserWindow, WebContentsView } = require('electron');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const option = (name, fallback) => {
	const hit = process.argv.find(a => a.startsWith('--repro-' + name + '='));
	return hit ? hit.slice(('--repro-' + name + '=').length) : fallback;
};
const HIDDEN = Number(option('hidden', '3'));
const SVGS = Number(option('svgs', '30'));
const SECONDS = Number(option('seconds', '720'));
const JS_FLAGS = option('js-flags', '');
const CHURN_SECONDS = Number(option('churn', '0'));
const KICKS = Number(option('kick', '3'));
const CORES = Number(option('cores', '0'));
const HOGS = Number(option('hogs', '0'));
const HOG_SECONDS = Number(option('hog-seconds', '0'));
const OUT = option('out', path.join(__dirname, 'results'));
const LABEL = option('label', [process.platform, 'h' + HIDDEN, 's' + SVGS, ...(JS_FLAGS ? ['flags'] : []), ...(CHURN_SECONDS ? ['churn' + CHURN_SECONDS] : []), ...(CORES ? ['c' + CORES] : []), ...(HOGS ? ['hogs' + HOGS + (HOG_SECONDS ? 'x' + HOG_SECONDS : '')] : [])].join('-'));
const SPIN_PCT = 15;

// Builds and drops DOM + JS garbage in a hidden tab, as a live page's updates do – so its GC runs
const CHURN_SCRIPT = `(() => {
	const box = document.createElement('div');
	for(let i = 0; i < 3000; i++) {
		const node = document.createElement('div');
		node.className = 'chip';
		node.textContent = 'x' + i;
		box.append(node);
	}
	document.body.append(box);
	box.getBoundingClientRect();
	box.remove();
	return Array.from({ length: 50000 }, (_, i) => ({ i })).length;
})()`;

// Pins a process to the first N cores, its later children inheriting that
const pinCores = (pid, cores) => {
	if(process.platform === 'win32') {
		execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process -Id ' + pid + ').ProcessorAffinity = ' + (2 ** cores - 1)]);
	} else if(process.platform === 'linux') {
		execFileSync('taskset', ['-a', '-cp', '0-' + (cores - 1), String(pid)], { stdio: 'ignore' });
	} else {
		throw new Error('--repro-cores needs Windows or Linux, as macOS has no CPU affinity');
	}
};

const readCores = (pid) => {
	try {
		if(process.platform === 'win32') return 'mask ' + execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process -Id ' + pid + ').ProcessorAffinity'], { encoding: 'utf8' }).trim();
		if(process.platform === 'linux') return execFileSync('taskset', ['-cp', String(pid)], { encoding: 'utf8' }).trim().split(': ').at(-1);
	} catch { return 'unknown'; }
	return 'all';
};

if(CORES) pinCores(process.pid, CORES);
if(JS_FLAGS) app.commandLine.appendSwitch('js-flags', JS_FLAGS);
app.setPath('userData', path.join(os.tmpdir(), 'svg-gc-repro-' + process.pid));
fs.mkdirSync(OUT, { recursive: true });
const logFile = path.join(OUT, LABEL + '.log');
const log = (text) => {
	const line = new Date().toISOString().slice(11, 19) + ' ' + text;
	console.log(line);
	fs.appendFileSync(logFile, line + '\n');
};

const describeCpu = () => {
	let cores = '';
	if(process.platform === 'darwin') {
		try {
			const read = (key) => execFileSync('sysctl', ['-n', key], { encoding: 'utf8' }).trim();
			const levels = Number(read('hw.nperflevels'));
			cores = ' (' + Array.from({ length: levels }, (_, i) => read('hw.perflevel' + i + '.logicalcpu') + ' ' + read('hw.perflevel' + i + '.name')).join(' + ') + ')';
		} catch { cores = ' (no perflevels)'; }
	}
	return os.cpus().length + ' logical cores' + cores + ', ' + os.cpus()[0]?.model;
};

const machineTimes = () => os.cpus().reduce((sum, cpu) => {
	const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
	return { busy: sum.busy + total - cpu.times.idle, total: sum.total + total };
}, { busy: 0, total: 0 });

const waitForTitle = (contents, title) => new Promise(resolve => {
	const check = () => (contents.getTitle() === title) ? resolve() : setTimeout(check, 200);
	check();
});

const readHeap = async (contents) => {
	const debug = contents.debugger;
	debug.attach('1.3');
	const heap = await debug.sendCommand('Runtime.getHeapUsage');
	const counters = await debug.sendCommand('Memory.getDOMCounters');
	debug.detach();
	return { documents: counters.documents, nodes: counters.nodes, jsMb: Math.round(heap.usedSize / 1048576), oilpanMb: Math.round(heap.embedderHeapUsedSize / 1048576) };
};

app.whenReady().then(async () => {
	log('Electron ' + process.versions.electron + ', Chrome ' + process.versions.chrome + ', V8 ' + process.versions.v8 + ' on ' + process.platform + ' ' + os.release() + ', ' + describeCpu());
	log('hidden tabs ' + HIDDEN + ', distinct SVGs ' + SVGS + ', js-flags ' + (JS_FLAGS || 'none') + ', ' + KICKS + ' kicks, churn every ' + (CHURN_SECONDS || '–') + 's, pinned to ' + (CORES || 'all') + ' cores, hogs ' + HOGS + (HOG_SECONDS ? ' for ' + HOG_SECONDS + 's' : '') + ', ' + SECONDS + 's');
	const win = new BrowserWindow({ width: 1200, height: 800, show: true, title: 'SVG GC repro' });
	const [width, height] = win.getContentSize();
	const tabs = [];
	for(let i = 0; i <= HIDDEN; i++) {
		const view = new WebContentsView();
		view.setBounds({ x: 0, y: 0, width, height });
		win.contentView.addChildView(view);
		await view.webContents.loadFile(path.join(__dirname, 'page.html'), { query: { svgs: String(SVGS), tab: String(i) } });
		await waitForTitle(view.webContents, 'ready');
		tabs.push(view);
	}
	// The first tab stays shown, the rest hide – as background tabs in a tabbed app
	await new Promise(r => setTimeout(r, 5000));
	tabs.forEach((view, i) => view.setVisible(i === 0));
	const pids = tabs.map(view => view.webContents.getOSProcessId());
	log('tabs loaded and hidden – renderer PIDs ' + pids.join(' ') + (new Set(pids).size < pids.length ? ' (shared!)' : '') + ', first renderer on ' + readCores(pids[1] ?? pids[0]));

	const hogs = Array.from({ length: HOGS }, () => spawn(process.execPath, ['-e', 'for(;;);'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' }));
	const stopHogs = () => hogs.splice(0).forEach(hog => hog.kill());
	if(HOG_SECONDS) setTimeout(() => { stopHogs(); log('hogs stopped'); }, HOG_SECONDS * 1000);
	const hiddenTabs = tabs.slice(1);
	const churn = () => hiddenTabs.forEach(view => view.webContents.executeJavaScript(CHURN_SCRIPT).catch(() => { }));
	// A few rounds of garbage right after hiding start the hidden tabs' GC – only a loop that feeds itself outlasts them
	for(let i = 0; i < KICKS; i++) setTimeout(churn, 5000 * (i + 1));
	if(CHURN_SECONDS) setInterval(churn, CHURN_SECONDS * 1000);

	const oilpan = hiddenTabs.map(() => []);
	const samples = [];
	let last = { at: Date.now(), cpu: new Map(app.getAppMetrics().map(m => [m.pid, m.cpu.cumulativeCPUUsage])), machine: machineTimes() };
	const began = Date.now();
	let round = 0;
	while(Date.now() - began < SECONDS * 1000) {
		await new Promise(r => setTimeout(r, 10000));
		const now = { at: Date.now(), cpu: new Map(app.getAppMetrics().map(m => [m.pid, m.cpu.cumulativeCPUUsage])), machine: machineTimes() };
		const seconds = (now.at - last.at) / 1000;
		const pct = pids.map(pid => Math.round(((now.cpu.get(pid) ?? 0) - (last.cpu.get(pid) ?? 0)) / seconds * 100));
		const machine = Math.round((now.machine.busy - last.machine.busy) / (now.machine.total - last.machine.total) * 100 * os.cpus().length);
		samples.push({ pct, machine });
		log('t=' + Math.round((now.at - began) / 1000) + 's machine ' + machine + '% of ' + (os.cpus().length * 100) + ' | visible ' + pct[0] + '% | hidden ' + pct.slice(1).map(p => p + '%').join(' '));
		last = now;
		// The Oilpan heap's swing shows the hidden tabs' GC ran at all
		if(++round % 3 === 0) {
			await Promise.all(hiddenTabs.map((view, i) => readHeap(view.webContents).then(heap => oilpan[i].push(heap.oilpanMb)).catch(() => { })));
		}
	}
	stopHogs();

	const late = samples.slice(-Math.max(1, Math.floor(samples.length / 3)));
	const average = (values) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
	const hiddenAvg = Array.from({ length: HIDDEN }, (_, i) => Math.round(average(late.map(s => s.pct[i + 1]))));
	const machineAvg = Math.round(average(late.map(s => s.machine)));
	const swing = oilpan.map(values => Math.min(...values) + '–' + Math.max(...values));
	const reads = [];
	for(const view of tabs) {
		const hidden = await view.webContents.executeJavaScript('document.hidden').catch(() => null);
		reads.push({ hidden, ...(await readHeap(view.webContents).catch(e => ({ error: e.message }))) });
	}
	log('tabs at end: ' + reads.map((r, i) => (i === 0 ? 'visible ' : 'hidden ') + JSON.stringify(r)).join(' | '));
	log('Oilpan MB per hidden tab over the run: ' + swing.join(', '));
	const spinning = hiddenAvg.filter(p => p >= SPIN_PCT).length;
	const result = { label: LABEL, platform: process.platform, logicalCores: os.cpus().length, pinnedCores: CORES, hogs: HOGS, hogSeconds: HOG_SECONDS, kicks: KICKS, churnSeconds: CHURN_SECONDS, cpu: describeCpu(), hidden: HIDDEN, svgs: SVGS, jsFlags: JS_FLAGS, seconds: SECONDS, hiddenAvg, machineAvg, spinning, oilpanSwing: swing, tabs: reads };
	fs.writeFileSync(path.join(OUT, LABEL + '.json'), JSON.stringify(result, null, '\t'));
	log('repro: ' + (spinning ? 'spin' : 'quiet') + ' – ' + spinning + ' of ' + HIDDEN + ' hidden tabs at ' + SPIN_PCT + '%+ over the last third (' + hiddenAvg.join('/') + '%), machine ' + machineAvg + '% of ' + (os.cpus().length * 100));
	app.quit();
});
