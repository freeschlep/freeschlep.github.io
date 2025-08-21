// src/lib/webgpuRenderer.js
export async function initWebGPUCanvas(canvas, width = 1024, height = 768) {
	if (!navigator.gpu) throw new Error("WebGPU not supported");

	const adapter = await navigator.gpu.requestAdapter();
	const device = await adapter.requestDevice();
	const context = canvas.getContext("webgpu");

	const format = navigator.gpu.getPreferredCanvasFormat();
	context.configure({ device, format, alphaMode: "premultiplied" });

	// Create texture to hold framebuffer pixels
	const texture = device.createTexture({
		size: [width, height],
		format: "rgba8unorm",
		usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
	});

	// Simple fullscreen quad shader
	const shaderModule = device.createShaderModule({
		code: `
struct VertexOut {
  @builtin(position) Position : vec4<f32>;
  @location(0) fragUV : vec2<f32>;
};

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex : u32) -> VertexOut {
  var pos = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(1.0, -1.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(1.0, -1.0),
    vec2<f32>(1.0, 1.0)
  );

  var uv = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(1.0, 0.0)
  );

  var output : VertexOut;
  output.Position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
  output.fragUV = uv[vertexIndex];
  return output;
}

@group(0) @binding(0) var myTexture: texture_2d<f32>;
@group(0) @binding(1) var mySampler: sampler;

@fragment
fn fsMain(in: VertexOut) -> @location(0) vec4<f32> {
  return textureSample(myTexture, mySampler, in.fragUV);
}
		`
	});

	const pipeline = device.createRenderPipeline({
		layout: "auto",
		vertex: { module: shaderModule, entryPoint: "vsMain" },
		fragment: {
			module: shaderModule,
			entryPoint: "fsMain",
			targets: [{ format }],
		},
		primitive: { topology: "triangle-list" }
	});

	const sampler = device.createSampler({
		magFilter: "linear",
		minFilter: "linear"
	});

	return { device, context, texture, pipeline, sampler, width, height };
}

// Push new framebuffer pixels to the GPU texture
export function updateWebGPUFramebuffer(device, texture, pixelData, width, height) {
	const imageData = new Uint8Array(pixelData.buffer); // assume RGBA8

	device.queue.writeTexture(
		{ texture: texture },
		imageData,
		{ bytesPerRow: width * 4 },
		[width, height, 1]
	);
}

// Render the texture to the canvas
export function renderWebGPU(device, context, pipeline, texture, sampler) {
	const commandEncoder = device.createCommandEncoder();
	const textureView = context.getCurrentTexture().createView();

	const renderPass = commandEncoder.beginRenderPass({
		colorAttachments: [{
			view: textureView,
			clearValue: { r: 0, g: 0, b: 0, a: 1 },
			loadOp: "clear",
			storeOp: "store"
		}]
	});

	renderPass.setPipeline(pipeline);
	renderPass.setBindGroup(0, device.createBindGroup({
		layout: pipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: texture.createView() },
			{ binding: 1, resource: sampler }
		]
	}));
	renderPass.draw(6, 1, 0, 0);
	renderPass.end();
	device.queue.submit([commandEncoder.finish()]);
}
