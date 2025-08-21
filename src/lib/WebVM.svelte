<script>
	import { onMount, tick } from 'svelte';
	import { get } from 'svelte/store';
	import Nav from 'labs/packages/global-navbar/src/Nav.svelte';
	import SideBar from '$lib/SideBar.svelte';
	import '$lib/global.css';
	import '@xterm/xterm/css/xterm.css';
	import '@fortawesome/fontawesome-free/css/all.min.css';
	import { networkInterface, startLogin } from '$lib/network.js';
	import { cpuActivity, diskActivity, cpuPercentage, diskLatency } from '$lib/activities.js';
	import { introMessage, errorMessage, unexpectedErrorMessage } from '$lib/messages.js';
	import { displayConfig, handleToolImpl } from '$lib/anthropic.js';
	import { tryPlausible } from '$lib/plausible.js';
	import { initWebGPU, updateTexture } from '$lib/webgpu.js';

	export let configObj = null;
	export let processCallback = null;
	export let cacheId = null;
	export let cpuActivityEvents = [];
	export let diskLatencies = [];
	export let activityEventsInterval = 0;

	let term = null;
	let cx = null;
	let fitAddon = null;
	let cxReadFunc = null;
	let blockCache = null;
	let processCount = 0;
	let curVT = 0;
	let sideBarPinned = false;

	let gpu = null; // WebGPU context holder

	// Terminal / CheerpX helpers
	function writeData(buf, vt) {
		if (vt != 1) return;
		term.write(new Uint8Array(buf));
	}

	function readData(str) {
		if (cxReadFunc == null) return;
		for (let i = 0; i < str.length; i++)
			cxReadFunc(str.charCodeAt(i));
	}

	function printMessage(msg) {
		for (let i = 0; i < msg.length; i++)
			term.write(msg[i] + "\n");
	}

	// CPU/Disk activity helpers
	function expireEvents(list, curTime, limitTime) {
		while (list.length > 1 && list[1].t < limitTime) list.shift();
	}

	function cleanupEvents() {
		const curTime = Date.now();
		const limitTime = curTime - 10000;
		expireEvents(cpuActivityEvents, curTime, limitTime);
		computeCpuActivity(curTime, limitTime);
		if (cpuActivityEvents.length === 0) {
			clearInterval(activityEventsInterval);
			activityEventsInterval = 0;
		}
	}

	function computeCpuActivity(curTime, limitTime) {
		let totalActiveTime = 0;
		let lastActiveTime = limitTime;
		let lastWasActive = false;
		for (const e of cpuActivityEvents) {
			let eTime = e.t < limitTime ? limitTime : e.t;
			if (e.state === "ready") {
				totalActiveTime += (eTime - lastActiveTime);
				lastWasActive = false;
			} else {
				lastActiveTime = eTime;
				lastWasActive = true;
			}
		}
		if (lastWasActive) totalActiveTime += (curTime - lastActiveTime);
		cpuPercentage.set(Math.ceil((totalActiveTime / 10000) * 100));
	}

	function hddCallback(state) { diskActivity.set(state !== "ready"); }

	function latencyCallback(latency) {
		diskLatencies.push(latency);
		if (diskLatencies.length > 30) diskLatencies.shift();
		const avg = diskLatencies.reduce((a, b) => a + b, 0) / diskLatencies.length;
		diskLatency.set(Math.ceil(avg));
	}

	function cpuCallback(state) {
		cpuActivity.set(state !== "ready");
		const curTime = Date.now();
		const limitTime = curTime - 10000;
		expireEvents(cpuActivityEvents, curTime, limitTime);
		cpuActivityEvents.push({ t: curTime, state });
		computeCpuActivity(curTime, limitTime);
		if (activityEventsInterval != 0) clearInterval(activityEventsInterval);
		activityEventsInterval = setInterval(cleanupEvents, 2000);
	}

	// Terminal font & resize
	function computeXTermFontSize() {
		return parseInt(getComputedStyle(document.body).fontSize);
	}

	function setScreenSize(display) {
		let internalMult = 1.0;
		const displayWidth = display.offsetWidth;
		const displayHeight = display.offsetHeight;
		const minWidth = 1024;
		const minHeight = 768;
		if (displayWidth < minWidth) internalMult = minWidth / displayWidth;
		if (displayHeight < minHeight) internalMult = Math.max(internalMult, minHeight / displayHeight);

		const internalWidth = Math.floor(displayWidth * internalMult);
		const internalHeight = Math.floor(displayHeight * internalMult);
		cx.setKmsCanvas(display, internalWidth, internalHeight);

		if (gpu) {
			gpu.texture = gpu.device.createTexture({
				size: [internalWidth, internalHeight],
				format: "rgba8unorm",
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
			});
		}

		// Screenshot config
		let screenshotMult = 1.0;
		const maxWidth = 1024;
		const maxHeight = 768;
		if (internalWidth > maxWidth) screenshotMult = maxWidth / internalWidth;
		if (internalHeight > maxHeight) screenshotMult = Math.min(screenshotMult, maxHeight / internalHeight);
		const screenshotWidth = Math.floor(internalWidth * screenshotMult);
		const screenshotHeight = Math.floor(internalHeight * screenshotMult);

		displayConfig.set({ width: screenshotWidth, height: screenshotHeight, mouseMult: internalMult * screenshotMult });
	}

	let curInnerWidth = 0;
	let curInnerHeight = 0;
	function handleResize() {
		if (curInnerWidth === window.innerWidth && curInnerHeight === window.innerHeight) return;
		curInnerWidth = window.innerWidth;
		curInnerHeight = window.innerHeight;
		triggerResize();
	}

	function triggerResize() {
		term.options.fontSize = computeXTermFontSize();
		fitAddon.fit();
		const display = document.getElementById("display");
		if (display) setScreenSize(display);
	}

	async function initTerminal() {
		const { Terminal } = await import('@xterm/xterm');
		const { FitAddon } = await import('@xterm/addon-fit');
		const { WebLinksAddon } = await import('@xterm/addon-web-links');

		term = new Terminal({ cursorBlink: true, convertEol: true, fontFamily: "monospace", fontWeight: 400, fontWeightBold: 700, fontSize: computeXTermFontSize() });
		fitAddon = new FitAddon();
		term.loadAddon(fitAddon);
		term.loadAddon(new WebLinksAddon());

		const consoleDiv = document.getElementById("console");
		term.open(consoleDiv);
		term.scrollToTop();
		fitAddon.fit();
		window.addEventListener("resize", handleResize);
		term.focus();
		term.onData(readData);

		function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }
		["dragover", "dragenter", "dragleave", "drop"].forEach(evt => consoleDiv.addEventListener(evt, preventDefaults));

		curInnerWidth = window.innerWidth;
		curInnerHeight = window.innerHeight;
		if (configObj.printIntro) printMessage(introMessage);

		try {
			await initCheerpX();
		} catch (e) {
			printMessage(unexpectedErrorMessage);
			printMessage([e.toString()]);
			return;
		}

		const display = document.getElementById("display");
		if (display && navigator.gpu) gpu = await initWebGPU(display);
	}

	async function initCheerpX() {
		const CheerpX = await import('@leaningtech/cheerpx');
		// Disk / overlay setup
		let blockDevice;
		switch (configObj.diskImageType) {
			case "cloud":
				blockDevice = await CheerpX.CloudDevice.create(configObj.diskImageUrl);
				break;
			case "bytes":
				blockDevice = await CheerpX.HttpBytesDevice.create(configObj.diskImageUrl);
				break;
			case "github":
				blockDevice = await CheerpX.GitHubDevice.create(configObj.diskImageUrl);
				break;
			default:
				throw new Error("Unrecognized device type");
		}

		blockCache = await CheerpX.IDBDevice.create(cacheId);
		const overlayDevice = await CheerpX.OverlayDevice.create(blockDevice, blockCache);
		const webDevice = await CheerpX.WebDevice.create("");
		const documentsDevice = await CheerpX.WebDevice.create("documents");
		const dataDevice = await CheerpX.DataDevice.create();
		const mountPoints = [
			{ type: "ext2", dev: overlayDevice, path: "/" },
			{ type: "dir", dev: webDevice, path: "/web" },
			{ type: "dir", dev: dataDevice, path: "/data" },
			{ type: "devs", path: "/dev" },
			{ type: "devpts", path: "/dev/pts" },
			{ type: "proc", path: "/proc" },
			{ type: "sys", path: "/sys" },
			{ type: "dir", dev: documentsDevice, path: "/home/user/documents" }
		];

		try { cx = await CheerpX.Linux.create({ mounts: mountPoints, networkInterface }); }
		catch (e) { printMessage(errorMessage); printMessage([e.toString()]); return; }

		cx.registerCallback("cpuActivity", cpuCallback);
		cx.registerCallback("diskActivity", hddCallback);
		cx.registerCallback("diskLatency", latencyCallback);
		cx.registerCallback("processCreated", () => { processCount++; if (processCallback) processCallback(processCount); });

		term.scrollToBottom();
		cxReadFunc = cx.setCustomConsole(writeData, term.cols, term.rows);

		const display = document.getElementById("display");
		if (display) { setScreenSize(display); cx.setActivateConsole(handleActivateConsole); }

		if (gpu) {
			cx.registerCallback("framebufferUpdate", (framebuffer, width, height) => {
				updateTexture(gpu.device, gpu.texture, framebuffer, width, height);
			});
		}

		while (true) await cx.run(configObj.cmd, configObj.args, configObj.opts);
	}

	function handleActivateConsole(vt) {
		if (curVT === vt) return;
		curVT = vt;
		if (vt !== 7) return;
		const display = document.getElementById("display");
		display.parentElement.style.zIndex = 5;
		tryPlausible("Display activated");
	}

	async function handleConnect() { 
		const w = window.open("login.html", "_blank"); 
		await cx.networkLogin(); 
		w.location.href = await startLogin(); 
	}

	async function handleReset() { if (!blockCache) return; await blockCache.reset(); location.reload(); }

	async function handleTool(tool) { return await handleToolImpl(tool, term); }

	async function handleSidebarPinChange(event) {
		sideBarPinned = event.detail;
		await tick();
		triggerResize();
	}
</script>

<main class="relative w-full h-full">
	<Nav />
	<div class="absolute top-10 bottom-0 left-0 right-0">
		<SideBar 
			on:connect={handleConnect} 
			on:reset={handleReset} 
			handleTool={!configObj.needsDisplay || curVT == 7 ? handleTool : null} 
			on:sidebarPinChange={handleSidebarPinChange}
		>
			<slot></slot>
		</SideBar>

		{#if configObj.needsDisplay}
			<div class="absolute top-0 bottom-0 {sideBarPinned ? 'left-[23.5rem]' : 'left-14'} right-0">
				<canvas class="w-full h-full cursor-none" id="display"></canvas>
			</div>
		{/if}

		<div class="absolute top-0 bottom-0 {sideBarPinned ? 'left-[23.5rem]' : 'left-14'} right-0 p-1 scrollbar" id="console"></div>
	</div>
</main>
