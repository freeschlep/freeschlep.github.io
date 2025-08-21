// webgpu.js
export async function initWebGPU(canvas) {
	if (!navigator.gpu) {
		console.warn("WebGPU not supported");
		return null;
	}

	const adapter = await navigator.gpu.requestAdapter();
	const device = await adapter.requestDevice();
	const context = canvas.getContext("webgpu");

	const format = navigator.gpu.getPreferredCanvasFormat();

	context.configure({
		device,
		format,
		alphaMode: "premultiplied"
	});

	return { device, context, format };
}

export function updateTexture(device, texture, framebuffer, width, height) {
	// Assume framebuffer is Uint8Array RGBA
	const imageData = new ImageData(new Uint8ClampedArray(framebuffer.buffer), width, height);

	// Create GPU buffer for the pixels
	const buffer = device.createBuffer({
		size: imageData.data.byteLength,
		usage: GPUBufferUsage.COPY_SRC,
		mappedAtCreation: true
	});

	new Uint8Array(buffer.getMappedRange()).set(imageData.data);
	buffer.unmap();

	// TODO: Copy buffer to GPU texture and render (simplest is to render as a fullscreen quad)
	// Implementation depends on whether you want a shader pass or just direct copy
}
