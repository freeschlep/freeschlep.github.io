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

	// ---------------- WebGPU state ----------------
	let gpuDevice, gpuContext, gpuPipeline, gpuTexture, gpuSampler, gpuFormat;

	function writeData(buf, vt) { if(vt != 1) return; term.write(new Uint8Array(buf)); }
	function readData(str) { if(cxReadFunc==null) return; for(let i=0;i<str.length;i++) cxReadFunc(str.charCodeAt(i)); }
	function printMessage(msg) { for(let i=0;i<msg.length;i++) term.write(msg[i] + "\n"); }

	// ---------------- CPU/Disk events ----------------
	function expireEvents(list, curTime, limitTime) { while(list.length > 1) { if(list[1].t < limitTime) list.shift(); else break; } }
	function computeCpuActivity(curTime, limitTime) {
		let totalActiveTime = 0, lastActiveTime = limitTime, lastWasActive = false;
		for(let e of cpuActivityEvents){
			let eTime = e.t < limitTime ? limitTime : e.t;
			if(e.state=="ready") { totalActiveTime += (eTime - lastActiveTime); lastWasActive=false; }
			else { lastActiveTime = eTime; lastWasActive=true; }
		}
		if(lastWasActive) totalActiveTime += (Date.now() - lastActiveTime);
		cpuPercentage.set(Math.ceil((totalActiveTime / 10000) * 100));
	}
	function cleanupEvents() {
		let curTime = Date.now(), limitTime = curTime - 10000;
		expireEvents(cpuActivityEvents, curTime, limitTime);
		computeCpuActivity(curTime, limitTime);
		if(cpuActivityEvents.length==0){ clearInterval(activityEventsInterval); activityEventsInterval=0; }
	}
	function cpuCallback(state){
		cpuActivity.set(state!="ready");
		let curTime = Date.now(), limitTime = curTime - 10000;
		expireEvents(cpuActivityEvents, curTime, limitTime);
		cpuActivityEvents.push({t:curTime,state});
		computeCpuActivity(curTime, limitTime);
		if(activityEventsInterval!=0) clearInterval(activityEventsInterval);
		activityEventsInterval = setInterval(cleanupEvents,2000);
	}
	function hddCallback(state){ diskActivity.set(state!="ready"); }
	function latencyCallback(latency){
		diskLatencies.push(latency);
		if(diskLatencies.length>30) diskLatencies.shift();
		diskLatency.set(Math.ceil(diskLatencies.reduce((a,b)=>a+b,0)/diskLatencies.length));
	}

	// ---------------- Terminal sizing ----------------
	function computeXTermFontSize(){ return parseInt(getComputedStyle(document.body).fontSize); }
	function setScreenSize(display){
		let internalMult = 1.0;
		let w = Math.max(display.offsetWidth, 1024);
		let h = Math.max(display.offsetHeight, 768);
		displayConfig.set({width:w,height:h,mouseMult:internalMult});
		if(gpuDevice) {
			gpuContext.configure({device:gpuDevice, format:gpuFormat, alphaMode:'opaque', width:w, height:h});
		}
	}

	let curInnerWidth = 0, curInnerHeight = 0;
	function handleResize(){
		if(curInnerWidth==window.innerWidth && curInnerHeight==window.innerHeight) return;
		curInnerWidth=window.innerWidth; curInnerHeight=window.innerHeight; triggerResize();
	}
	function triggerResize(){
		term.options.fontSize = computeXTermFontSize();
		fitAddon.fit();
		const display=document.getElementById("display");
		if(display) setScreenSize(display);
	}

	// ---------------- WebGPU init ----------------
	async function initWebGPU(canvas){
		const adapter = await navigator.gpu.requestAdapter();
		gpuDevice = await adapter.requestDevice();
		gpuContext = canvas.getContext('webgpu');
		gpuFormat = navigator.gpu.getPreferredCanvasFormat();
		gpuContext.configure({device:gpuDevice, format:gpuFormat, alphaMode:'opaque', width:canvas.width, height:canvas.height});
		gpuTexture = gpuDevice.createTexture({size:[canvas.width,canvas.height], format:'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT});
		gpuSampler = gpuDevice.createSampler();
		gpuPipeline = gpuDevice.createRenderPipeline({
			layout:'auto',
			vertex:{module:gpuDevice.createShaderModule({code:`@vertex fn main(@builtin(vertex_index) idx:u32)->@builtin(position) vec4<f32>{ var pos=array<vec2<f32>,3>(vec2<f32>(-1,-1),vec2<f32>(3,-1),vec2<f32>(-1,3)); return vec4<f32>(pos[idx],0,1); }`}),
			entryPoint:'main'},
			fragment:{module:gpuDevice.createShaderModule({code:`@fragment fn main()->@location(0) vec4<f32>{ return vec4<f32>(1.0,0.0,0.0,1.0); }`}), entryPoint:'main', targets:[{format:gpuFormat}]},
			primitive:{topology:'triangle-list'}
		});
	}

	function renderWebGPUFramebuffer(pixels,width,height){
		if(!gpuDevice) return;
		// Upload pixels to texture & render
		const imageData = new Uint8Array(pixels.buffer);
		gpuDevice.queue.writeTexture({texture:gpuTexture},{data:imageData,bytesPerRow:width*4},{width,height,depthOrArrayLayers:1});
		const commandEncoder = gpuDevice.createCommandEncoder();
		const renderPass = commandEncoder.beginRenderPass({colorAttachments:[{view:gpuContext.getCurrentTexture().createView(), loadOp:'clear', storeOp:'store', clearValue:{r:0,g:0,b:0,a:1}}]});
		renderPass.setPipeline(gpuPipeline);
		renderPass.draw(3,1,0,0);
		renderPass.end();
		gpuDevice.queue.submit([commandEncoder.finish()]);
	}

	// ---------------- Terminal init ----------------
	async function initTerminal(){
		const {Terminal} = await import('@xterm/xterm');
		const {FitAddon} = await import('@xterm/addon-fit');
		const {WebLinksAddon} = await import('@xterm/addon-web-links');
		term = new Terminal({cursorBlink:true, convertEol:true, fontFamily:"monospace", fontWeight:400, fontWeightBold:700, fontSize:computeXTermFontSize()});
		fitAddon=new FitAddon(); term.loadAddon(fitAddon); term.loadAddon(new WebLinksAddon());
		const consoleDiv=document.getElementById("console");
		term.open(consoleDiv); term.scrollToTop(); fitAddon.fit();
		window.addEventListener("resize",handleResize);
		term.focus(); term.onData(readData);
		['dragover','dragenter','dragleave','drop'].forEach(evt=>consoleDiv.addEventListener(evt,e=>{e.preventDefault();e.stopPropagation();},false));
		curInnerWidth=window.innerWidth; curInnerHeight=window.innerHeight;
		if(configObj.printIntro) printMessage(introMessage);
		await initCheerpX();
	}

	// ---------------- CheerpX init ----------------
	async function initCheerpX(){
		if(configObj.needsDisplay){
			const canvas=document.getElementById("display");
			await initWebGPU(canvas);
		}
		const CheerpX = await import('@leaningtech/cheerpx');
		let blockDevice=null;
		switch(configObj.diskImageType){
			case "cloud": blockDevice = await CheerpX.CloudDevice.create(configObj.diskImageUrl); break;
			case "bytes": blockDevice = await CheerpX.HttpBytesDevice.create(configObj.diskImageUrl); break;
			case "github": blockDevice = await CheerpX.GitHubDevice.create(configObj.diskImageUrl); break;
			default: throw new Error("Unknown disk type");
		}
		blockCache = await CheerpX.IDBDevice.create(cacheId);
		const overlayDevice = await CheerpX.OverlayDevice.create(blockDevice, blockCache);
		const webDevice = await CheerpX.WebDevice.create("");
		const documentsDevice = await CheerpX.WebDevice.create("documents");
		const dataDevice = await CheerpX.DataDevice.create();
		const mountPoints = [
			{type:"ext2", dev:overlayDevice, path:"/"},
			{type:"dir", dev:webDevice, path:"/web"},
			{type:"dir", dev:dataDevice, path:"/data"},
			{type:"devs", path:"/dev"},
			{type:"devpts", path:"/dev/pts"},
			{type:"proc", path:"/proc"},
			{type:"sys", path:"/sys"},
			{type:"dir", dev:documentsDevice, path:"/home/user/documents"}
		];
		cx = await CheerpX.Linux.create({mounts:mountPoints,networkInterface});
		cx.registerCallback("cpuActivity",cpuCallback);
		cx.registerCallback("diskActivity",hddCallback);
		cx.registerCallback("diskLatency",latencyCallback);
		cx.registerCallback("processCreated",()=>{processCount++; if(processCallback) processCallback(processCount);});

		cxReadFunc = cx.setCustomConsole(writeData,term.cols,term.rows);
		if(configObj.needsDisplay && gpuDevice){
			cx.registerCallback("framebuffer",(pixels,w,h)=>renderWebGPUFramebuffer(pixels,w,h));
		}

		cx.setActivateConsole(vt=>{ if(vt==7) tryPlausible("Display activated"); });

		while(true) await cx.run(configObj.cmd, configObj.args, configObj.opts);
	}

	onMount(initTerminal);

	// ---------------- Sidebar events ----------------
	async function handleConnect(){ const w=window.open("login.html","_blank"); await cx.networkLogin(); w.location.href=await startLogin(); }
	async function handleReset(){ if(blockCache==null) return; await blockCache.reset(); location.reload(); }
	async function handleTool(tool){ return await handleToolImpl(tool,term); }
	async function handleSidebarPinChange(event){ sideBarPinned=event.detail; await tick(); triggerResize(); }

</script>

<main class="relative w-full h-full">
	<Nav/>
	<div class="absolute top-10 bottom-0 left-0 right-0">
		<SideBar on:connect={handleConnect} on:reset={handleReset} handleTool={!configObj.needsDisplay || curVT==7?handleTool:null} on:sidebarPinChange={handleSidebarPinChange}>
			<slot></slot>
		</SideBar>
		{#if configObj.needsDisplay}
			<div class="absolute top-0 bottom-0 {sideBarPinned?'left-[23.5rem]':'left-14'} right-0">
				<canvas class="w-full h-full cursor-none" id="display"></canvas>
			</div>
		{/if}
		<div class="absolute top-0 bottom-0 {sideBarPinned?'left-[23.5rem]':'left-14'} right-0 p-1 scrollbar" id="console"></div>
	</div>
</main>
