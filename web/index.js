const nav = navigator;
const work_util = new Worker('work-util.js');
const work_serial = new Worker('work-serial.js');
const touch = nav.maxTouchPoints > 1 || (/android/i.test(nav.userAgent));
const clamp = (num, min, max) => Math.min(Math.max(num, min), max);
const service_worker = navigator.serviceWorker;
const LS = localStorage;
const exports = {};
const lines = [];
const progress = "O...................".split('');

const config = {
    origin: { X:0, Y:0, Z:0 },
    status: { feed: [] },
    jog_xy: parseInt(LS.jog_xy || 10),
    jog_z: parseInt(LS.jog_z || 10),
    jog_a: parseInt(LS.jog_a || 90),
    stock_x: parseFloat(LS.stock_x || 80),
    stock_y: parseFloat(LS.stock_y || 80),
    stock_z: parseFloat(LS.stock_z || 25),
    dark: safe_parse(LS.dark || true),
    file_data: '',
    setup: false,
    fails: 0,
    last: Date.now()
};

document.onreadystatechange = status => {
    if (document.readyState === 'complete') {
        set_dark();
        start_service_worker();
        connect_command_channel();
        bind_ui();
        bind_ports();
        exports.canvas.init();
        hello();
    }
};

work_serial.onmessage = (message) => {
    message_handler(message.data);
};

work_serial.onerror = (err) => {
    $('sys-serial').style.display = 'none';
};

work_util.onmessage = (message) => {
    // log({ work_util_says: message.data });
    const { md5, dbop, dbdata, bounds, job } = message.data;
    if (md5 && config.upload) {
        const { file, data } = config.upload;
        config.db.put(file, { md5, data });
        delete config.upload;
    }
    if (dbop) {
        if (config.dbthen) {
            config.dbthen(dbdata);
            delete config.dbthen;
        }
    }
    if (bounds) {
        update_bounds(bounds);
    }
    if (job) {
        config.job = job;
    }
}

setInterval(() => {
    work_util.postMessage({ ping: Date.now() });
}, 100);

function update_bounds(bounds) {
    config.bounds = bounds;
    const { X, Y, Z } = bounds.stock ? bounds.stock : {};
    const auto = $('stock-auto').checked && X && Y && Z;
    $('stock-auto').disabled = !(X && Y && Z);
    $('stock-x').value = (auto ? X : config.stock_x) | 0;
    $('stock-y').value = (auto ? Y : config.stock_y) | 0;
    $('stock-z').value = (auto ? Z : config.stock_z) | 0;
    $('stock-auto').onchange = () => {
        update_bounds(config.bounds);
        exports.canvas.run_check();
    };
}

function dbop() {
    return new Promise((resolve, reject) => {
        config.dbthen = resolve;
        const args = [...arguments];
        work_util.postMessage({ dbop: args.shift(), dbargs: args });
    });
}

const db = config.db = {
    get(key) {
        return dbop('get', key);
    },
    put(key, val) {
        return dbop('put', key, val);
    },
    remove(key) {
        return dbop('remove', key);
    }
};

function save_config() {
    LS.stock_x = config.stock_x;
    LS.stock_y = config.stock_y;
    LS.stock_z = config.stock_z;
    LS.jog_xy = config.jog_xy;
    LS.jog_z = config.jog_z;
    LS.jog_a = config.jog_a;
    LS.dark = config.dark;
}

function set_enabled(bool) {
    if (bool === false) {
        exports.canvas.run_cancel();
    }
    // log({ set_enabled: bool });
    const select = [...document.getElementsByTagName('SELECT')];
    const inputs = [...document.getElementsByTagName('INPUT')];
    const buttons = [...document.getElementsByTagName('BUTTON')];
    for (let b of [...inputs, ...buttons, ...select]) {
        if (b.id !== 'sys-serial' && b.id !== 'sys-tcp' && b.id.indexOf('mod-') < 0) {
            if (b.default_disabled === undefined) {
                b.default_disabled = b.disabled;
            }
            b.disabled = bool ? b.default_disabled : true;
        }
    }
}

function set_dark(dark = config.dark) {
    config.dark = dark;
    save_config();
    const body = document.body;
    if (dark) {
        body.classList.add('dark');
    } else {
        body.classList.remove('dark');
    }
}

function flash_modal(msg, time) {
    set_progress();
    set_modal(msg);
    setTimeout(set_modal, time);
}

function set_modal(msg = false) {
    clearTimeout(config.modal_bump);
    clearTimeout(config.modal_delay);
    show_modal_buttons(false);
    set_progress();
    if (msg === false) {
        $('modal').style.display = 'none';
    } else {
        $('modal').style.display = 'flex';
        if (typeof msg === 'string') {
            $('mod-mesg').innerHTML = msg;
        }
    }
}

function set_modal_delay(msg, delay, bump) {
    clearTimeout(config.modal_bump);
    clearTimeout(config.modal_delay);
    config.modal_delay = setTimeout(() => {
        set_modal(msg)
        config.modal_bump = bump ? setInterval(bump_progress, bump) : undefined;
    }, delay);
}

function show_modal_buttons(bool) {
    $('mod-btns').style.display = bool ? '' : 'none';
}

function set_progress(msg) {
    $('mod-prog').innerText = msg || '';
    $('mod-prog').style.display = msg ? '' : 'none';
}

function bump_progress() {
    let mark = Date.now();
    if (mark - config.last > 100) {
        progress.push(progress.shift());
        set_progress(progress.slice().reverse().join(''));
        config.last = mark;
    }
}

function log() {
    console.log('[-]', ...arguments);
}

function debug() {
    console.log('[D]', ...arguments);
}

function $(id) {
    return document.getElementById(id);
}

function send(msg) {
    // command channel depends on serial or tcp
    if (config.serial) {
        work_serial.postMessage(msg);
    } else if (config.ws) {
        config.ws.send(JSON.stringify(msg));
    } else {
        log({ no_send_channel_for: msg });
    }
}

function sendRaw(buf) {
    // command channel depends on serial or tcp
    if (config.serial) {
        work_serial.postMessage(buf);
    } else if (config.ws) {
        config.ws.send(buf);
    } else {
        log({ no_send_channel_for: buf });
    }
}

function ls(path) {
    path = '/' + (path || "/sd/gcodes")
        .split('/')
        .filter(p => p)
        .join('/');
    send({ ls: path });
}

function rm(path) {
    send({ rm: path });
    setTimeout(() => {
        omode_cmd();
        ls(config.dir);
    }, 500);
}

function run(path) {
    gcmd(`play ${path}`)
}

function download(path, md5) {
    send({ download: path, md5 });
}

function gcmd() {
    for (let gcmd of [...arguments]) {
        send({ gcmd });
    }
}

function gcmd_direct() {
    for (let gcmd of [...arguments]) {
        send({ gcmd, raw: true });
    }
}

function upload_file(file) {
    const upload = `${config.dir || "/sd/gcodes/"}${file.name}`;
    const reader = new FileReader()
    reader.readAsArrayBuffer(file);
    reader.onloadend = (event) => {
        sendRaw(event.target.result);
        send({ upload });
        log({ upload, data: event.target.result });
        config.upload = { file: upload, data: new TextDecoder().decode(event.target.result) };
        work_util.postMessage({ md5: config.upload.data });
        omode_cmd();
    };
}

function run_file() {
    exports.canvas.run_setup();
}

function load_file(path) {
    delete config.bounds;
    if (typeof path === 'string') {
        cache_load(`${path}`);
    } else if (config.selected_file) {
        const { dir, file } = config.selected_file;
        cache_load(`${dir}${file}`);
    }
}

async function cache_load(path) {
    log({ cache_load: path });
    set_modal_delay('checking file cache', 100, 200);
    const rec = await config.db.get(path);
    if (rec) {
        config.file = path;
        config.file_data = rec.data;
        download(path, rec.md5);
    } else {
        download(path);
    }
}

function delete_file() {
    if (config.selected_file) {
        const { dir, file } = config.selected_file;
        const path = `${dir}${file}`;
        rm(path);
        config.db.remove(path);
    }
}

function select_file(div, dir, file) {
    if (config.selected_file) {
        config.selected_file.div.classList.remove('selected');
    }
    if (div) {
        div.classList.add('selected');
    }
    config.selected_file = div ? { div, dir, file } : undefined;
    exports.canvas.run_check();
}

function upload() {
    $('upload-input').onchange = (ev) => {
        upload_file(event.target.files[0]);
    }
    $('upload-input').click();
}

function omode_cmd(array) {
    if (Array.isArray(array)) {
        lines.push(...array);
    }
    config.omode = 'cmd';
    $('output').innerText = lines.join('\n');
    $('output').scrollTop = $('output').scrollHeight;
}

function omode_file() {
    config.omode = 'file';
    $('output').innerText = config.file_data;
}

function set_feed(value, delta = 0, send = true) {
    value = clamp(parseInt(value) + delta, 50, 200);
    config.status.feed[2] = value;
    if (send) gcmd(`M220 S${value}`);
    $('f-range').value = value;
    $('f-scale').value = `${value}%`;
}

function set_spin(value, delta = 0, send = true) {
    value = clamp(parseInt(value) + delta, 50, 200);
    config.status.spin[2] = value;
    if (send) gcmd(`M223 S${value}`);
    $('s-range').value = value;
    $('s-scale').value = `${value}%`;
}

function set_laser(value, delta = 0, send = true) {
    value = clamp(parseInt(value) + delta, 10, 100);
    config.status.laser[4] = value;
    if (send) gcmd(`M325 S${value}`);
    $('l-range').value = value;
    $('l-scale').value = `${value}%`;
}

function message_handler(message) {
    // log('message', message);
    const { status, found, connected } = message;
    const { lines_in, lines_out, xmodem } = message;
    const { dir, list, file, data, md5, md5sum, uploaded, error, work } = message;
    if (error) {
        omode_cmd([`[error] ${error}`]);
        set_modal(false);
    }
    switch (xmodem) {
        case 'start':
            set_modal('file transfer in progress');
            break;
        case 'end':
            set_modal(false);
            break;
        case 'progress':
            bump_progress();
            break;
    }
    if (status) {
        const { state, mpos, wpos, feed, spin, tool, probe, laser } = status;
        config.play = status.play;
        config.status = status;
        $('state').innerText = state;
        $('x-world').innerText = wpos[0].toFixed(3);
        $('x-local').innerText = mpos[0].toFixed(3);
        $('y-world').innerText = wpos[1].toFixed(3);
        $('y-local').innerText = mpos[1].toFixed(3);
        $('z-world').innerText = wpos[2].toFixed(3);
        $('z-local').innerText = mpos[2].toFixed(3);
        $('a-world').innerText = mpos[3].toFixed(3);
        $('a-local').innerText = mpos[3].toFixed(3);
        $('f-world').innerText = feed[0].toFixed(0);
        $('f-local').innerText = feed[1].toFixed(0);
        $('s-value').innerText = spin[0].toFixed(0);
        $('s-vacon').innerText = `${spin[2]}%`;
        $('t-index').innerText = tool ? tool[0] : 'None';
        $('t-ofset').innerText = tool && tool[1] ? tool[1].toFixed(3) : `PV: ${probe[0].toFixed(2)}`;
        $('l-world').innerText = laser ? laser[0].toFixed(1) : '0.0';
        $('l-local').innerText = laser ? `${laser[4]}%` : '100%';
        set_feed(feed[2], 0, false);
        set_spin(spin[2], 0, false);
        set_laser(laser ? laser[4] : 100, 0, false)
        exports.canvas.run_check();
    } else if (connected !== undefined) {
        $('sys-serial').disabled = connected;
        $('sys-tcp').disabled = connected;
        config.connected = connected;
        set_enabled(connected);
        omode_cmd([`carvera ${connected ? 'connected' : 'disconnected'}`]);
    } else if (found) {
        $('name').innerText = config.found = found.name;
        omode_cmd([`carvera (${found.name}) at ${found.ip}:${found.port}`]);
    } else if (dir) {
        config.dir = dir.length ? `/${dir.join('/')}/` : '/';
        const path = [ "/", ...dir ];
        $('path').innerHTML = path.map((d,i) => {
            return `<button path="/${path.slice(1,i+1).join('/')}">${d}</button>`;
        }).join('')
            + `<span></span><button onclick='upload()'>upload`
            + `<input id="upload-input" type="file" accept=".nc, .gcode">`
            + `</input></button>`;
        for (let b of [...$('path').childNodes]) {
            if (!b.onclick) {
                b.onclick = () => {
                    ls(b.getAttribute('path'));
                };
            }
        }
    }
    if (!config.setup && config.connected && !config.play) {
        config.sync = true;
        config.setup = true;
        cache_load('/sd/config.txt');
    }
    if (list) {
        $('files').innerHTML = list.map(f => {
            let isDir = f.name.indexOf('/') > 0;
            let file = isDir ? f.name.replace('/','') : f.name;
            let size = isDir ? '' : comma(f.size);
            let attr = isDir ? ' class="dir"' : '';
            return `<div><label${attr}>${file}</label><label>${size}</label></div>`;
        }).join('');
        for (let div of [...$('files').childNodes]) {
            div.onclick = () => {
                let file = div.childNodes[0].innerText;
                let size = div.childNodes[1].innerText;
                if (size === '') {
                    ls(`${config.dir}${file}`);
                } else {
                    select_file(div, config.dir, file);
                    // log('load', config.dir, file);
                }
            };
        }
    }
    if (file && data) {
        on_file(file, data, md5);
    }
    if (file && md5) {
        log({ file, md5 });
        on_file_data();
    }
    if (uploaded) {
        log({ uploaded });
        setTimeout(() => {
            ls(config.dir || "/sd/gcodes");
        }, 500);
    }
    if (lines_in) {
        lines.push(...lines_in.map(l => `<< ${l}`));
    }
    if (lines_out) {
        lines.push(...lines_out.map(l => `>> ${l}`));
    }
    while (lines.length > 50) {
        lines.shift();
    }
    if ((lines_in || lines_out) && config.omode === 'cmd') {
        omode_cmd();
    }
}

function on_file(file, data, md5) {
    on_file_data(file, data);
    config.db.put(file, { md5, data });
}

function on_file_data(file, data) {
    file = config.file = file || config.file;
    data = config.file_data = data || config.file_data;
    if (config.sync) {
        config.sync = false;
    } else {
        omode_file();
        exports.canvas.run_clear();
    }
    if (file === '/sd/config.txt') {
        on_config(data);
    }
}

function safe_parse(v) {
    try {
        return JSON.parse(v);
    } catch (e) {
        return v;
    }
}

function on_config(data) {
    const kv = data.split('\n')
        .map(v => v.trim())
        .filter(v => v.charAt(0) !== '#')
        .filter(v => v.length)
        .map(v => v.replace(/\s+/g, ' '))
        .map(v => v.replace(/\t/g, ''))
        .map(v => v.split('#')[0].trim().split(' '));
    const map = config.map = {}
    const mapo = config.mapo = {};
    for (let [k,v] of kv) {
        const val = map[k] = safe_parse(v);
        const tok = k.split('.');
        let put = mapo;
        while (tok.length > 1) {
            const next = tok.shift();
            put = put[next] = put[next] || {};
        }
        put[tok.shift()] = val;
    }
    work_util.postMessage({ settings: map });
    setTimeout(() => {
        log('seed file list');
        ls('/sd/gcodes');
    }, 350);
}

// required with manifest.json for PWA installs
async function start_service_worker() {
    if (!service_worker) {
        log('service workers not supported');
        return;
    }

    const pkg = await fetch('/package.json').then(r => r.json());
    const version = pkg.version;
    const islocal = location.hostname === 'localhost' && !localStorage.prodmode;
    const devmode = islocal || localStorage.devmode || false;
    const install = location.hash.indexOf('install') >= 0;
    const runserv = !devmode || install;

    if (runserv)
    try {
        // install service worker
        debug('service worker registration');

        const reg = await service_worker.register(`service.js?${version}`, { scope: "/" });
        if (reg.installing) {
            debug('service worker installing');
        } else if (reg.waiting) {
            debug('service worker waiting');
        } else if (reg.active) {
            debug('service worker active');
        } else {
            debug({ service_worker: reg });
        }
    } catch (err) {
        debug('service worker registration failed', err);
    }

    if (service_worker.controller && runserv) {
        debug('service worker deregister');
        service_worker.controller.postMessage(`unregister`);
    }
}

function connect_command_channel(urlroot = '') {
    if (location.host === 'cc.grid.space') {
        $('sys-serial').disabled = false;
        return;
    }
    const pre = { "https:": "wss:", "http:": "ws:" }[location.protocol];
    const wss = new WebSocket(`${pre}//${location.host}${urlroot}/socket`);
    wss.onopen = event => {
        // debug('wss open', event);
        config.ws = wss;
        config.connected = true;
        config.fails = 0;
        $('sys-tcp').style.display = 'block';
    };
    wss.onmessage = event => {
        message_handler(safe_parse(event.data));
    };
    wss.onclose = event => {
        set_modal(false);
        set_enabled(false);
        $('sys-tcp').style.display = '';
        $('sys-serial').disabled = false;
        $('sys-usb').disabled = false;
        config.ws = undefined;
        config.connected = false;
        if (config.fails++ < 5) {
            setTimeout(connect_command_channel, 1000);
        }
    }
    wss.onerror = event => {
        if (config.connected) {
            debug('wss error', event);
        }
    }
}

function bind_ui() {
    // config-set sd light.turn_off_min 10.0
    // xmodem cancel after crc match [16][16][16]

    window.addEventListener('keydown', ev => {
        if (ev.key === 'Escape') {
            set_modal(false);
        }
    });

    const body = document.body;

    if (touch) {
        body.classList.add('touch');
    }

    $('state').onclick = () => {
        set_dark(!config.dark);
    };

    $('name').onclick = () => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            body.requestFullscreen();
        }
    };

    $('sys-stop').onclick = () => { gcmd_direct('\x18') };
    $('sys-unlock').onclick = () => { gcmd('$X') };
    $('sys-resume').onclick = () => { gcmd_direct('~') };
    $('sys-hold').onclick = () => { gcmd_direct('!') };
    $('sys-reset').onclick = () => {
        if (confirm('reboot the Carvera mill?')) {
            gcmd('reset');
        }
    };

    const jog_xy = $('jog-xy');
    const jog_z = $('jog-z');
    const jog_a = $('jog-a');

    jog_xy.value = config.jog_xy;
    jog_z.value = config.jog_z;
    jog_a.value = config.jog_a;

    jog_xy.onchange = () => {
        config.jog_xy = parseInt(jog_xy.options[jog_xy.selectedIndex].value);
        save_config();
    };
    jog_z.onchange = () => {
        config.jog_z = parseInt(jog_z.options[jog_z.selectedIndex].value);
        save_config();
    };
    jog_a.onchange = () => {
        config.jog_a = parseInt(jog_a.options[jog_a.selectedIndex].value);
        save_config();
    };

    $('stock-x').value = config.stock_x;
    $('stock-y').value = config.stock_y;
    $('stock-z').value = config.stock_z;

    $('x-add').onclick = () => { gcmd(`G91G0X${config.jog_xy}`)  };
    $('x-sub').onclick = () => { gcmd(`G91G0X-${config.jog_xy}`) };
    $('y-add').onclick = () => { gcmd(`G91G0Y${config.jog_xy}`)  };
    $('y-sub').onclick = () => { gcmd(`G91G0Y-${config.jog_xy}`) };
    $('z-add').onclick = () => { gcmd(`G91G0Z${config.jog_z}`)   };
    $('z-sub').onclick = () => { gcmd(`G91G0Z-${config.jog_z}`)  };
    $('a-add').onclick = () => { gcmd(`G91G0A${config.jog_a}`)   };
    $('a-sub').onclick = () => { gcmd(`G91G0A-${config.jog_a}`)  };

    $('ctrl-home').onclick = () => { gcmd('$H') };
    $('ctrl-clear').onclick = () => { gcmd('M496.1') };
    $('ctrl-origin').onclick = () => { gcmd('M496.2') };
    $('ctrl-anchor1').onclick = () => { gcmd('M496.3') };
    $('ctrl-anchor2').onclick = () => { gcmd('M496.4') };
    $('ctrl-set-origin').onclick = () => {
        const { mpos } = config.status;
        config.origin.X = mpos[0];
        config.origin.Y = mpos[1];
        gcmd(`G10 L2 P0 X${mpos[0]} Y${mpos[1]}`);
        flash_modal('origin set', 800);
    };

    $('x-zero').onclick = () => { gcmd('G10L20P0X0') };
    $('y-zero').onclick = () => { gcmd('G10L20P0Y0') };
    $('z-zero').onclick = () => { gcmd('G10L20P0Z0') };
    $('a-zero').onclick = () => { gcmd('G92.4A0')    };
    $('a-shrink').onclick = () => { gcmd('G92.4A0')  };

    $('tool-drop').onclick = () => { gcmd('M6T-1') };
    $('tool-empty').onclick = () => { gcmd('M493.2T-1') };
    $('tool-calibrate').onclick = () => { gcmd('M491') };

    for (let i = 0; i <= 6; i++) {
        $(`tset-${i}`).onclick = () => {
            gcmd(`M493.2T${i}`);
        };
        $(`tchg-${i}`).onclick = () => {
            gcmd(`M6T${i}`);
        };
    }

    $('file-run').onclick = run_file;
    $('file-load').onclick = load_file;
    $('file-delete').onclick = delete_file;

    $('omode-cmd').onclick = omode_cmd;
    $('omode-file').onclick = omode_file;

    $('upload').onclick = () => {
        $('upload-input').click();
    };

    $('files').ondrop = (ev) => {
        ev.preventDefault();
        $('files').classList.remove('dragover');
        upload_file(ev.dataTransfer.files[0]);
    };
    $('files').ondragover = (ev) => {
        ev.preventDefault();
        $('files').classList.add('dragover');
        ev.dataTransfer.dropEffect = 'copy';
    };
    $('files').ondragleave = (ev) => {
        ev.preventDefault();
        $('files').classList.remove('dragover');
    };

    $('commands').onkeydown = $('cmd-xmit').onclick = (ev) => {
        // log({ ev });
        if (ev.key === 'Enter' || ev.pointerType) {
            if (ev.ctrlKey || ev.metaKey) {
                lines.length = 0;
                omode_cmd();
            } else {
                omode_cmd();
                gcmd(ev.target.value.trim());
                ev.target.value = '';
            }
        }
    };

    $('f-range').onchange = (ev) => {
        set_feed(ev.target.value);
    };
    $('f-add').onclick = () => {
        set_feed(config.status.feed[2] || 100, 10);
    };
    $('f-sub').onclick = () => {
        set_feed(config.status.feed[2] || 100, -10);
    };
    $('f-reset').onclick = () => {
        set_feed(100, 0);
    }
    $('vacon').onclick = () => {
        gcmd('M331');
    };
    $('vacoff').onclick = () => {
        gcmd('M332');
    };

    $('s-range').onchange = (ev) => {
        set_spin(ev.target.value);
    };
    $('s-add').onclick = () => {
        set_spin(config.status.spin[2] || 100, 10);
    };
    $('s-sub').onclick = () => {
        set_spin(config.status.spin[2] || 100, -10);
    };
    $('s-reset').onclick = () => {
        set_spin(100, 0);
    }

    $('l-range').onchange = (ev) => {
        set_laser(ev.target.value);
    };
    $('l-add').onclick = () => {
        set_laser(config.status.laser[4] || 100, 10);
    };
    $('l-sub').onclick = () => {
        set_laser(config.status.laser[4] || 100, -10);
    };
    $('l-reset').onclick = () => {
        set_laser(100, 0);
    }
    $('l-enable').onclick = () => {
        gcmd('m321');
    }
    $('l-disable').onclick = () => {
        gcmd('m322');
    }

    omode_cmd();
}

function bind_ports() {
    if (navigator.usb) {
        $('sys-serial').style.display = 'block';
    }
    $('sys-serial').onclick = bind_serial;
    $('sys-usb').onclick = () => {
        navigator.usb.requestDevice({
            filters:[{
                vendorId: 0x0403,
                productId: 0x6001
            }]
        }).then(p => {
            $('output').innerText = JSON.stringify({ p });
        }).catch(e => {
            log({ error: e });
        });
    };
    $('sys-tcp').onclick = bind_network;
}

async function bind_serial() {
    let serial = navigator.serial || exports.ftdi || exports.serial;
    let ports = await serial.getPorts();
    let port = ports && ports[0];
    if (!port) {
        port = await serial.requestPort({
            filters:[{
                usbVendorId: 0x0403,
                usbProductId: 0x6001,
            }]
        });
    }
    if (port) {
        work_serial.postMessage('serial');
        config.serial = true;
    }
}

function bind_network() {
    send({ connect: !config.connected });
}

function hello() {
    if (LS.hello) {
        return;
    }
    $('mod-cancel').style.display = 'none';
    $('mod-ok').onclick = () => {
        set_modal(false);
        show_modal_buttons(false);
        $('mod-cancel').style.display = '';
    };
    LS.hello = Date.now();
    set_modal([
        `<div id="hello">`,
        `<h2>Carve Control</h2>`,
        `<div>An Open Source Controller and</div>`,
        `<div>Network Proxy for Maker's Carvera</div>`,
        `<div>`,
        `<label>Check it out on</label>`,
        `<a href="https://github.com/GridSpace/carve-control" target="alt">GitHub</a></div>`,
        `</div>`
    ].join(''));
    show_modal_buttons(true);
}

function comma(v) {
    if (!v) return v;
    let [lt, rt] = v.toString().split('.');
    lt = lt.toString().split('').reverse().map((v, i, a) => {
        return (i < a.length - 1 && i % 3 === 2) ? `,${v}` : v
    }).reverse().join('');
    return rt ? `${lt}.${rt}` : lt;
}
