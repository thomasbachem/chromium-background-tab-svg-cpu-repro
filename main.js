// Opens one visible and N hidden tabs on a page using S distinct SVG images, then samples
// each tab's renderer CPU every 10s and ends on a `repro:` verdict line
const { app, BrowserWindow, WebContentsView } = require('electron');
const { execFileSync } = require('node:child_process');
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
const OUT = option('out', path.join(__dirname, 'results'));
const LABEL = option('label', process.platform + '-h' + HIDDEN + '-s' + SVGS + (JS_FLAGS ? '-flags' : ''));
const SPIN_PCT = 15;

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
	return os.availableParallelism() + ' logical cores' + cores + ', ' + os.cpus()[0]?.model;
};

const machineTimes = () => os.cpus().reduce((sum, cpu) => {
	const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
	return { busy: sum.busy + total - cpu.times.idle, total: sum.total + total };
}, { busy: 0, total: 0 });

const waitForTitle = (contents, title) => new Promise(resolve => {
	const check = () => (contents.getTitle() === title) ? resolve() : setTimeout(check, 200);
	check();
});

const readTab = async (contents) => {
	const hidden = await contents.executeJavaScript('document.hidden');
	const debug = contents.debugger;
	debug.attach('1.3');
	const counters = await debug.sendCommand('Memory.getDOMCounters');
	const heap = await debug.sendCommand('Runtime.getHeapUsage');
	debug.detach();
	return { hidden, documents: counters.documents, nodes: counters.nodes, jsMb: Math.round(heap.usedSize / 1048576), oilpanMb: Math.round(heap.embedderHeapUsedSize / 1048576) };
};

app.whenReady().then(async () => {
	log('Electron ' + process.versions.electron + ', Chrome ' + process.versions.chrome + ', V8 ' + process.versions.v8 + ' on ' + process.platform + ' ' + os.release() + ', ' + describeCpu());
	log('hidden tabs ' + HIDDEN + ', distinct SVGs ' + SVGS + ', js-flags ' + (JS_FLAGS || 'none') + ', ' + SECONDS + 's');
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
	log('tabs loaded and hidden – renderer PIDs ' + pids.join(' ') + (new Set(pids).size < pids.length ? ' (shared!)' : ''));

	const samples = [];
	let last = { at: Date.now(), cpu: new Map(app.getAppMetrics().map(m => [m.pid, m.cpu.cumulativeCPUUsage])), machine: machineTimes() };
	const began = Date.now();
	while(Date.now() - began < SECONDS * 1000) {
		await new Promise(r => setTimeout(r, 10000));
		const now = { at: Date.now(), cpu: new Map(app.getAppMetrics().map(m => [m.pid, m.cpu.cumulativeCPUUsage])), machine: machineTimes() };
		const seconds = (now.at - last.at) / 1000;
		const pct = pids.map(pid => Math.round(((now.cpu.get(pid) ?? 0) - (last.cpu.get(pid) ?? 0)) / seconds * 100));
		const machine = Math.round((now.machine.busy - last.machine.busy) / (now.machine.total - last.machine.total) * 100 * os.availableParallelism());
		samples.push({ pct, machine });
		log('t=' + Math.round((now.at - began) / 1000) + 's machine ' + machine + '% of ' + (os.availableParallelism() * 100) + ' | visible ' + pct[0] + '% | hidden ' + pct.slice(1).map(p => p + '%').join(' '));
		last = now;
	}

	const late = samples.slice(-Math.max(1, Math.floor(samples.length / 3)));
	const average = (values) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
	const hiddenAvg = Array.from({ length: HIDDEN }, (_, i) => Math.round(average(late.map(s => s.pct[i + 1]))));
	const machineAvg = Math.round(average(late.map(s => s.machine)));
	const reads = [];
	for(const view of tabs) reads.push(await readTab(view.webContents).catch(e => ({ error: e.message })));
	log('tabs at end: ' + reads.map((r, i) => (i === 0 ? 'visible ' : 'hidden ') + JSON.stringify(r)).join(' | '));
	const spinning = hiddenAvg.filter(p => p >= SPIN_PCT).length;
	const result = { label: LABEL, platform: process.platform, cores: os.availableParallelism(), cpu: describeCpu(), hidden: HIDDEN, svgs: SVGS, jsFlags: JS_FLAGS, seconds: SECONDS, hiddenAvg, machineAvg, spinning, tabs: reads };
	fs.writeFileSync(path.join(OUT, LABEL + '.json'), JSON.stringify(result, null, '\t'));
	log('repro: ' + (spinning ? 'spin' : 'quiet') + ' – ' + spinning + ' of ' + HIDDEN + ' hidden tabs at ' + SPIN_PCT + '%+ over the last third (' + hiddenAvg.join('/') + '%), machine ' + machineAvg + '% of ' + (os.availableParallelism() * 100));
	app.quit();
});
