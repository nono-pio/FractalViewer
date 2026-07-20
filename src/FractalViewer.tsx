import {useEffect, useRef, useState, type WheelEventHandler} from "react";


const shaderCode = /* wgsl */`
struct Uniforms {
    time : f32,
    pos : vec2f,
    size : vec2f,
    max_iter : u32,
    color_mode : u32
};

@group(0) @binding(0) var<uniform> u : Uniforms;

struct VSOut {
    @builtin(position) position : vec4f,
    @location(0) uv : vec2f, // dom = [0,1]
};

@vertex
fn vs(@builtin(vertex_index) i : u32) -> VSOut {
    var p = array<vec2f, 6>(
        vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0, 1.0),
        vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0, 1.0)
    );
    var out : VSOut;
    let pos = p[i];
    out.position = vec4f(pos, 0.0, 1.0);
    out.uv = pos * 0.5 + 0.5; // [-1,1] -> [0,1]
    return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
    let uv = u.pos + in.uv * u.size;
    let t = u.time;

    var i : u32 = 0;
    var x = uv.x;
    var y = uv.y;

    let MAX = u.max_iter;
    while (i < MAX) {
        if (x * x + y * y >= 4.0) {
            break;
        }

        let temp = x * x - y * y + uv.x;
        y = 2.0 * x * y + uv.y;
        x = temp;

        i = i + 1;
    }
    
    if (u.color_mode == 0) {
        return blue_white(i, MAX);
    }
    
    if (u.color_mode == 1) {
        return good_blue(x, y, i, MAX);
    }
    
    return color_green_dark(i, MAX);
}


fn blue_white(i : u32, MAX : u32) -> vec4f {
    if (i == MAX) {
        return vec4f(0.0, 0.0, 0.0, 1.0);
    }

    let l = min(f32(i) / 50.0 / 2.0 + 0.5, 1.0);

    return vec4f(2.0*l - 1.0, 2.0*l - 1.0, 1.0, 1.0);
}

fn color_green_dark(n : u32, max_iter : u32) -> vec4f {
    if (n < max_iter) {
        let quotient : f32 =  f32(n) / f32(max_iter);
        let color = clamp(0.0, 1.0, quotient);
        if (quotient > 0.5) {
            // Close to the mandelbrot set the color changes from green to white
            return vec4f(color, 1.0, color, 1.0);
        }
        else {
            // Far away it changes from black to green
            return vec4f(0.0, color, 0.0, 1.0);
        }
    }
    
    return vec4f(0.0,0.0,0.0,1.0);
}

fn good_blue(re : f32, im : f32, i : u32, MAX : u32) -> vec4f {
    
    if (i < MAX) {
        let zn = sqrt(re * re + im * im);
        let smooth_ = f32(i) + 1.0 - log(max(log(zn), 1e-10)) / log(2.0);
        let t_ = clamp(0.0, 1.0, smooth_ / f32(MAX));
        let t = pow(t_, 0.5);
        let r = t * t;
        let g = t * 220.0 / 255.0;
        let b = 60.0 / 255.0 + t * 195.0 / 255.0;
        return vec4f(r, g, b, 1.0);
    }
    
    return vec4f(0.0,0.0,0.0,1.0);
}

`;

async function setup(canvas: HTMLCanvasElement, errBox: HTMLDivElement, viewRef: { current: View }, iterRef: {
    current: Props["iteration"]
}, time_per_iteration: number, colorRef : {current : Props["color_mode"]}) {
    function fail(msg: string) {
        errBox.style.display = 'grid'
        errBox.textContent = msg;
        throw new Error(msg);
    }

    if (!navigator.gpu)
        fail("WebGPU n'est pas disponible dans ce navigateur.");

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter)
        fail("Aucun adaptateur GPU trouvé.");
    const device = await adapter!.requestDevice();

    const context = canvas.getContext('webgpu')!;
    const format = navigator.gpu.getPreferredCanvasFormat(); // souvent 'bgra8unorm'
    context.configure({
        device,
        format,
        alphaMode: 'opaque'
    });

    const module = device.createShaderModule({code: shaderCode});
    const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {module, entryPoint: 'vs'},
        fragment: {module, entryPoint: 'fs', targets: [{format}]},
        primitive: {topology: 'triangle-list'},
    });

    // Group 0 : Layout 0 : row = 8 bytes
    // time (f32) | - |
    // pos (vec2f)
    // size (vec2f)
    // max_iter (u32) | color_mode (u32) |
    const size = 4; // number of 8 bytes of the uniform data
    const uniformBuffer = device.createBuffer({
        size: size * 8,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{binding: 0, resource: {buffer: uniformBuffer}}],
    });
    const buf = new ArrayBuffer(size * 8);
    const dv = new DataView(buf);

    function resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
        canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    }

    window.addEventListener('resize', resize);
    resize();

    const start = performance.now();
    let rafId = 0;
    let running = true;

    function frame() {
        if (!running) return;

        const view = viewRef.current;
        const time = (performance.now() - start) / 1000
        let max_iter;
        if (iterRef.current == 'auto') {
            max_iter = 100
            if (view.width < 1.0e-5) max_iter *= 2;
            if (view.width < 1.0e-11) max_iter *= 2;
            if (view.width < 1.0e-17) max_iter *= 2;

        } else if (iterRef.current == 'time_incremental') {
            max_iter = Math.floor(time / time_per_iteration)
        } else {
            max_iter = iterRef.current ?? 100;
        }


        const mode = colorRef.current;
        let color_mode;
        switch (mode) {
            case "blue": color_mode = 0; break;
            case "better_blue": color_mode = 1; break;
            case "green": color_mode = 2; break;
            default: color_mode = 1; break;
        }

        dv.setFloat32(0, time, true);
        dv.setFloat32(8, view.pos_x, true);
        dv.setFloat32(12, view.pos_y, true);
        dv.setFloat32(16, view.width, true);
        dv.setFloat32(20, view.height, true);
        dv.setUint32(24, max_iter, true);
        dv.setUint32(28, color_mode, true);

        device.queue.writeBuffer(uniformBuffer, 0, buf);

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: context.getCurrentTexture().createView(),
                clearValue: {r: 0, g: 0, b: 0, a: 1},
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(6); // 6 vertices of the 2 triangles = rectangle
        pass.end();

        device.queue.submit([encoder.finish()]);
        rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);

    return () => { // cleaning function
        running = false;
        cancelAnimationFrame(rafId);
        window.removeEventListener('resize', resize);
        device.destroy();
    };
}

interface View {
    pos_x: number,
    pos_y: number,
    width: number,
    height: number
}

const DEFAULT_VIEW = {
    pos_x: -2,
    pos_y: -1.5,
    width: 3,
    height: 3
}

interface Props {
    width?: number | string,
    height?: number | string,
    iteration?: number | 'auto' | 'time_incremental',
    default_view?: View,
    scale_factor?: number,
    time_per_iteration?: number,
    color_mode? : 'blue' | 'better_blue' | 'green',
}

// Renders an interactive Mandelbrot fractal on a WebGPU canvas with scroll-to-zoom.
export default function FractalViewer(
    {
        width = 400,
        height = 400,
        iteration = 'auto',
        default_view = DEFAULT_VIEW,
        scale_factor = 0.8,
        time_per_iteration = 0.2,
        color_mode = 'better_blue'

    }: Props) {

    console.assert(0 < scale_factor && scale_factor <= 1)

    let canvas = useRef<HTMLCanvasElement>(null)
    let errBox = useRef<HTMLDivElement>(null)
    let [view, setView] = useState<View>(default_view)

    let viewRef = useRef(view)
    viewRef.current = view;
    let iterationRef = useRef(iteration)
    iterationRef.current = iteration
    let colorRef = useRef(color_mode);
    colorRef.current = color_mode

    useEffect(() => {

        if (!errBox.current || !canvas.current) {
            return;
        }

        let dispose: (() => void) | null = null;
        let cancelled = false;

        setup(canvas.current, errBox.current, viewRef, iterationRef, time_per_iteration, colorRef)
            .then(cleanup => {
                if (cancelled) cleanup();
                else dispose = cleanup;
            })
            .catch(console.error);

        return () => {
            cancelled = true;
            dispose?.();
        };

    }, []);

    const onScroll: WheelEventHandler<HTMLCanvasElement> = e => {
        let scale = e.deltaY < 0 ? scale_factor : 1 / scale_factor // zoom factor

        // Cursor's position in canvas (px)
        const rect = e.currentTarget.getBoundingClientRect()
        let relative_x = e.clientX - rect.left
        let relative_y = rect.height - e.clientY - rect.top // inverted

        // Cursor's position in view (fractal coordinates)
        let view_x = relative_x * view.width / rect.width + view.pos_x
        let view_y = relative_y * view.height / rect.height + view.pos_y

        // New bottom-left corner, scaled so the cursor point stays put
        let xs = view_x * (1 - scale) + scale * view.pos_x
        let ys = view_y * (1 - scale) + scale * view.pos_y

        setView({
            pos_x: xs,
            pos_y: ys,
            width: scale * view.width,
            height: scale * view.height
        })
    }


    return (
        <div>
            <canvas onWheel={onScroll} id="gpu" ref={canvas} width={width} height={height}
                    style={{display: "block"}}></canvas>
            <div id="err" ref={errBox} style={{
                position: "fixed",
                inset: 0,
                display: "none",
                placeItems: "center",
                color: "#fff",
                font: "16px/1.5 system-ui, sans-serif",
                padding: "2rem",
                textAlign: "center",
                background: "#111",
            }}/>
        </div>
    );
}




