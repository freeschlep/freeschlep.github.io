export async function initWebGPU(canvas) {
    if (!navigator.gpu) throw new Error("WebGPU not supported");
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "premultiplied" });

    // Create a texture for the framebuffer
    const texture = device.createTexture({
        size: [canvas.width, canvas.height],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING |
               GPUTextureUsage.COPY_DST |
               GPUTextureUsage.RENDER_ATTACHMENT
    });

    return { device, context, texture, format };
}

export function updateTexture(device, texture, framebuffer, width, height) {
    device.queue.writeTexture(
        { texture },
        framebuffer,
        { bytesPerRow: width * 4 },
        [width, height, 1]
    );
}
