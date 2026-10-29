// script.js - Xử lý LUT và video bằng WebGL
(function() {
    const video = document.getElementById('videoElement');
    const canvas = document.getElementById('canvasElement');
    const videoInput = document.getElementById('videoInput');
    const lutInput = document.getElementById('lutInput');
    const intensitySlider = document.getElementById('lutIntensity');
    const intensityValue = document.getElementById('intensityValue');
    const exportBtn = document.getElementById('exportBtn');
    const statusDiv = document.getElementById('status');

    // Trạng thái
    let gl = null;
    let program = null;
    let videoTexture = null;
    let lutTexture = null;
    let lutSize = 0;
    let isReady = false;
    let animationId = null;
    let mediaRecorder = null;
    let recordedChunks = [];

    // Shader sources (WebGL 1)
    const vertexShaderSource = `
        attribute vec2 a_position;
        attribute vec2 a_texCoord;
        varying vec2 v_texCoord;
        void main() {
            gl_Position = vec4(a_position, 0.0, 1.0);
            v_texCoord = a_texCoord;
        }
    `;

    const fragmentShaderSource = `
        precision mediump float;
        varying vec2 v_texCoord;
        uniform sampler2D u_video;
        uniform sampler2D u_lut;
        uniform float u_lutSize;
        uniform float u_intensity;

        vec3 applyLUT(vec3 color) {
            // Chuyển đổi màu (0..1) thành tọa độ trong lưới 3D LUT
            // LUT texture là 2D, chứa các slice của khối 3D
            float size = u_lutSize;
            float sliceSize = size * size; // số pixel mỗi slice
            float sliceIndex = color.b * (size - 1.0); // slice theo blue
            float sliceFrac = fract(sliceIndex);
            float slice0 = floor(sliceIndex);
            float slice1 = min(slice0 + 1.0, size - 1.0);

            // Tọa độ trong slice: x = red, y = green
            float x = color.r * (size - 1.0);
            float y = color.g * (size - 1.0);

            // Tính toán UV cho texture 2D chứa LUT
            // Texture có kích thước (size*size) x size, mỗi hàng là một slice blue
            vec2 texSize = vec2(size * size, size);
            // Lấy mẫu slice 0
            vec2 uv0 = vec2((slice0 * size + x) / texSize.x, y / texSize.y);
            // Lấy mẫu slice 1
            vec2 uv1 = vec2((slice1 * size + x) / texSize.x, y / texSize.y);

            vec3 c0 = texture2D(u_lut, uv0).rgb;
            vec3 c1 = texture2D(u_lut, uv1).rgb;
            return mix(c0, c1, sliceFrac);
        }

        void main() {
            vec4 videoColor = texture2D(u_video, v_texCoord);
            vec3 graded = applyLUT(videoColor.rgb);
            vec3 finalColor = mix(videoColor.rgb, graded, u_intensity);
            gl_FragColor = vec4(finalColor, videoColor.a);
        }
    `;

    // Khởi tạo WebGL
    function initGL() {
        gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
        if (!gl) {
            statusDiv.textContent = 'WebGL không được hỗ trợ.';
            return false;
        }

        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, vertexShaderSource);
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
            console.error(gl.getShaderInfoLog(vs));
            return false;
        }

        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, fragmentShaderSource);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
            console.error(gl.getShaderInfoLog(fs));
            return false;
        }

        program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error(gl.getProgramInfoLog(program));
            return false;
        }

        gl.useProgram(program);

        // Tạo quad full-screen
        const positions = new Float32Array([
            -1, -1, 1, -1, -1, 1,
            -1, 1, 1, -1, 1, 1
        ]);
        const texCoords = new Float32Array([
            0, 0, 1, 0, 0, 1,
            0, 1, 1, 0, 1, 1
        ]);

        const posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
        const aPosition = gl.getAttribLocation(program, 'a_position');
        gl.enableVertexAttribArray(aPosition);
        gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

        const texBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
        const aTexCoord = gl.getAttribLocation(program, 'a_texCoord');
        gl.enableVertexAttribArray(aTexCoord);
        gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 0, 0);

        // Tạo texture cho video
        videoTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, videoTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        // Tạo texture cho LUT
        lutTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, lutTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        gl.uniform1i(gl.getUniformLocation(program, 'u_video'), 0);
        gl.uniform1i(gl.getUniformLocation(program, 'u_lut'), 1);

        return true;
    }

    // Tải video
    videoInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const url = URL.createObjectURL(file);
        video.src = url;
        video.load();
        video.onloadedmetadata = () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            gl.viewport(0, 0, canvas.width, canvas.height);
            statusDiv.textContent = 'Video đã tải. Nhập LUT để xem trước.';
            checkReady();
        };
    });

    // Phân tích tệp .cube
    function parseCube(text) {
        const lines = text.split(/\r?\n/);
        let size = 0;
        const data = [];
        for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith('#') || line.startsWith('TITLE') || line.startsWith('DOMAIN')) continue;
            if (line.startsWith('LUT_3D_SIZE')) {
                size = parseInt(line.split(/\s+/)[1]);
                continue;
            }
            // Các dòng dữ liệu: R G B
            const parts = line.split(/\s+/);
            if (parts.length >= 3) {
                const r = parseFloat(parts[0]);
                const g = parseFloat(parts[1]);
                const b = parseFloat(parts[2]);
                if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
                    data.push(r, g, b);
                }
            }
        }
        if (size === 0 || data.length !== size * size * size * 3) {
            throw new Error('Định dạng LUT không hợp lệ hoặc kích thước không khớp.');
        }
        return { size, data: new Float32Array(data) };
    }

    // Tạo texture LUT 2D từ dữ liệu 3D
    function createLUTTexture(lut) {
        const size = lut.size;
        const data = lut.data;
        // Texture có kích thước (size*size) x size, mỗi hàng là một slice blue
        const width = size * size;
        const height = size;
        const textureData = new Uint8Array(width * height * 4); // RGBA

        for (let b = 0; b < size; b++) {
            for (let g = 0; g < size; g++) {
                for (let r = 0; r < size; r++) {
                    const idx = ((b * size + g) * size + r) * 3;
                    const x = b * size + r;
                    const y = g;
                    const texIdx = (y * width + x) * 4;
                    textureData[texIdx] = Math.round(data[idx] * 255);
                    textureData[texIdx + 1] = Math.round(data[idx + 1] * 255);
                    textureData[texIdx + 2] = Math.round(data[idx + 2] * 255);
                    textureData[texIdx + 3] = 255;
                }
            }
        }

        gl.bindTexture(gl.TEXTURE_2D, lutTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, textureData);
        gl.uniform1f(gl.getUniformLocation(program, 'u_lutSize'), size);
        lutSize = size;
    }

    // Xử lý nhập LUT
    lutInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const lut = parseCube(ev.target.result);
                createLUTTexture(lut);
                statusDiv.textContent = `Đã tải LUT kích thước ${lut.size}.`;
                checkReady();
            } catch (err) {
                statusDiv.textContent = 'Lỗi LUT: ' + err.message;
            }
        };
        reader.readAsText(file);
    });

    // Cường độ
    intensitySlider.addEventListener('input', () => {
        const val = parseFloat(intensitySlider.value);
        intensityValue.textContent = Math.round(val * 100) + '%';
        if (gl && program) {
            gl.uniform1f(gl.getUniformLocation(program, 'u_intensity'), val);
        }
    });

    function checkReady() {
        isReady = video.readyState >= 2 && lutSize > 0 && gl;
        exportBtn.disabled = !isReady;
        if (isReady) {
            startRenderLoop();
        }
    }

    // Vòng lặp render
    function render() {
        if (!gl || !program) return;
        if (video.readyState >= 2) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, videoTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        }
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, lutTexture);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        animationId = requestAnimationFrame(render);
    }

    function startRenderLoop() {
        if (animationId) cancelAnimationFrame(animationId);
        render();
    }

    // Xuất video
    exportBtn.addEventListener('click', () => {
        if (!isReady || !canvas.captureStream) {
            statusDiv.textContent = 'Không thể xuất video (thiếu hỗ trợ captureStream).';
            return;
        }
        const stream = canvas.captureStream(30); // 30 fps
        // Thêm âm thanh từ video gốc nếu có
        try {
            const audioStream = video.captureStream ? video.captureStream() : null;
            if (audioStream) {
                const audioTracks = audioStream.getAudioTracks();
                audioTracks.forEach(track => stream.addTrack(track));
            }
        } catch (e) { /* bỏ qua nếu không có âm thanh */ }

        mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
        recordedChunks = [];
        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) recordedChunks.push(e.data);
        };
        mediaRecorder.onstop = () => {
            const blob = new Blob(recordedChunks, { type: 'video/webm' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'graded_video.webm';
            a.click();
            URL.revokeObjectURL(url);
            statusDiv.textContent = 'Đã xuất video.';
            exportBtn.disabled = false;
        };
        mediaRecorder.start();
        exportBtn.disabled = true;
        statusDiv.textContent = 'Đang ghi video...';
        video.play();
        video.onended = () => {
            mediaRecorder.stop();
            video.onended = null;
        };
    });

    // Khởi tạo
    if (initGL()) {
        statusDiv.textContent = 'Sẵn sàng. Tải video và LUT.';
        gl.uniform1f(gl.getUniformLocation(program, 'u_intensity'), 1.0);
    }
})();
