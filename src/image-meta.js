// 图片自带元数据：AI 图的「出处」经常不在网上，而在文件里。
//
// 为什么需要这一层：反查引擎（Lens / SauceNAO）只认「网上有过这张图」。
// 一张 SD/ComfyUI/NovelAI 生成的图只要没被传到 pixiv/civitai，再好的引擎也查不到 ——
// 但它的 PNG/JPEG 里往往有完整生成参数（模型、提示词、seed、采样器），
// 甚至 C2PA 签名（DALL·E / GPT 图片 / Midjourney 会写）。
// 把这段读出来，用户至少能知道「这是什么模型生成的、提示词是什么」，
// 而不是收到一句「没查到」。
//
// 纯 Node 内置模块，不引依赖：PNG 走 chunk，JPEG 走 APP1/TIFF，WebP 走 RIFF。

import zlib from 'node:zlib';

const MAX_BLOB = 200000; // 单个元数据块最多看这么多，防止畸形文件把内存吃满

function str(buf, from = 0, to = buf.length) {
  return Buffer.from(buf.subarray(from, to)).toString('utf8');
}

/** 按文件头认容器 —— 扩展名不作数（QQ 下来的图常被改名）。 */
export function sniffContainer(bytes) {
  if (!bytes || bytes.length < 12) return 'unknown';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (str(bytes, 0, 4) === 'RIFF' && str(bytes, 8, 12) === 'WEBP') return 'webp';
  if (str(bytes, 0, 3) === 'GIF') return 'gif';
  return 'unknown';
}

// ── PNG ────────────────────────────────────────────────────────────────────

function pngTextFields(bytes) {
  const fields = {};
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(off);
    const type = bytes.toString('ascii', off + 4, off + 8);
    const start = off + 8;
    const end = start + len;
    if (len < 0 || end > bytes.length) break;
    const data = bytes.subarray(start, Math.min(end, start + MAX_BLOB));
    try {
      if (type === 'tEXt') {
        const nul = data.indexOf(0);
        if (nul > 0) {
          const key = data.toString('latin1', 0, nul);
          fields[key] = data.toString('latin1', nul + 1);
        }
      } else if (type === 'zTXt') {
        const nul = data.indexOf(0);
        if (nul > 0) {
          const key = data.toString('latin1', 0, nul);
          fields[key] = zlib.inflateSync(data.subarray(nul + 2)).toString('utf8');
        }
      } else if (type === 'iTXt') {
        const nul = data.indexOf(0);
        if (nul > 0) {
          const key = data.toString('latin1', 0, nul);
          const compressed = data[nul + 1] === 1;
          let p = nul + 3;
          p = data.indexOf(0, p) + 1; // language tag
          if (p > 0) {
            p = data.indexOf(0, p) + 1; // translated keyword
            const body = data.subarray(p);
            fields[key] = compressed ? zlib.inflateSync(body).toString('utf8') : body.toString('utf8');
          }
        }
      } else if (type === 'caBX') {
        fields.__c2pa = 'png-caBX';
      }
    } catch {
      // 单个块解不开不影响其它块
    }
    off = end + 4;
    if (type === 'IEND') break;
  }
  return fields;
}

// ── JPEG ───────────────────────────────────────────────────────────────────

function jpegSegments(bytes) {
  const segs = [];
  let off = 2;
  while (off + 4 <= bytes.length) {
    if (bytes[off] !== 0xff) { off += 1; continue; }
    const marker = bytes[off + 1];
    if (marker === 0xff) { off += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    if (marker === 0xda) break; // SOS 之后是压缩图像数据
    const len = bytes.readUInt16BE(off + 2);
    if (len < 2) break;
    const start = off + 4;
    const end = Math.min(off + 2 + len, bytes.length);
    segs.push({ marker, data: bytes.subarray(start, end) });
    off = end;
  }
  return segs;
}

function exifFields(app1) {
  const out = {};
  if (str(app1, 0, 6) !== 'Exif\0\0') return out;
  const tiff = app1.subarray(6);
  if (tiff.length < 8) return out;
  const le = str(tiff, 0, 2) === 'II';
  const rd16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const rd32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const NAMES = { 0x010e: 'ImageDescription', 0x010f: 'Make', 0x0110: 'Model', 0x0131: 'Software', 0x9286: 'UserComment' };
  try {
    let ifd = rd32(4);
    for (let hop = 0; hop < 4 && ifd > 0 && ifd + 2 < tiff.length; hop += 1) {
      const count = rd16(ifd);
      if (count > 512) break;
      for (let i = 0; i < count; i += 1) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > tiff.length) break;
        const tag = rd16(entry);
        const name = NAMES[tag];
        if (!name) continue;
        const num = rd32(entry + 4);
        const valOff = rd32(entry + 8);
        let buf = null;
        if (num <= 4) buf = tiff.subarray(entry + 8, entry + 8 + Math.min(num, 4));
        else if (valOff + Math.min(num, MAX_BLOB) <= tiff.length) buf = tiff.subarray(valOff, valOff + Math.min(num, MAX_BLOB));
        if (!buf || !buf.length) continue;
        let text = buf.toString('utf8');
        // UserComment 头 8 字节是字符集标记
        text = text.replace(/^(ASCII|UNICODE|JIS|\\x00)\0*/i, '').replace(/\0+$/g, '');
        if (text.trim()) out[name] = text;
      }
      ifd = rd32(ifd + 2 + count * 12);
    }
  } catch {
    // TIFF 结构坏掉就放弃，元数据只是锦上添花
  }
  return out;
}

function jpegFields(bytes) {
  const fields = {};
  for (const seg of jpegSegments(bytes)) {
    if (seg.marker === 0xe1) {
      const head = str(seg.data, 0, 29);
      if (/^Exif\0\0/.test(head)) Object.assign(fields, exifFields(seg.data));
      else if (/^http:\/\/ns\.adobe\.com\/xap\/1\.0\/\0/.test(head)) fields.__xmp = str(seg.data, 29);
      else if (/^http:\/\/ns\.adobe\.com\/xmp\/extension\/\0/.test(head)) fields.__xmp = (fields.__xmp ?? '') + str(seg.data, 35);
    } else if (seg.marker === 0xeb && /c2pa|jumb/i.test(str(seg.data, 0, 64))) {
      fields.__c2pa = 'jpeg-APP11';
    }
  }
  return fields;
}

// ── WebP ───────────────────────────────────────────────────────────────────

function webpFields(bytes) {
  const fields = {};
  let off = 12;
  while (off + 8 <= bytes.length) {
    const type = str(bytes, off, off + 4);
    const size = bytes.readUInt32LE(off + 4);
    const start = off + 8;
    const end = Math.min(start + size, bytes.length);
    const data = bytes.subarray(start, Math.min(end, start + MAX_BLOB));
    if (type === 'EXIF') Object.assign(fields, exifFields(data));
    else if (type === 'XMP ') fields.__xmp = str(data);
    off = end + (size % 2);
    if (end >= bytes.length) break;
  }
  return fields;
}

// ── 从文本里认生成器 / 参数 ────────────────────────────────────────────────

const GENERATORS = [
  [/comfyui|CheckpointLoaderSimple|KSampler/i, 'ComfyUI'],
  [/automatic1111|a1111|stable diffusion webui/i, 'Stable Diffusion WebUI'],
  [/novelai/i, 'NovelAI'],
  [/fooocus/i, 'Fooocus'],
  [/invokeai/i, 'InvokeAI'],
  [/sd\.next/i, 'SD.Next'],
  [/draw things/i, 'Draw Things'],
  [/midjourney/i, 'Midjourney'],
  [/dall[·\- ]?e/i, 'DALL·E'],
  [/gpt-image|chatgpt/i, 'GPT Image'],
  [/nijijourney/i, 'NijiJourney'],
  [/flux/i, 'FLUX'],
  [/sdxl|sd_xl/i, 'SDXL'],
  [/comfy/i, 'ComfyUI']
];

const AI_SOFTWARE = /novelai|stable diffusion|comfyui|fooocus|invokeai|a1111|automatic1111|sd\.next|draw things|midjourney|krea|leonardo|firefly|ideogram|imagen|qwen[-_ ]?image|seedream|hunyuan/i;

/** 「Steps: 30, Sampler: Euler a, CFG scale: 7, Seed: 1, Model: x」这种尾巴拆成对象。 */
export function parseSettingLine(text) {
  const out = {};
  const line = String(text ?? '');
  // 只在「最后一行」里找参数尾巴：前面是自然语言提示词，逗号结构完全不同
  const tail = line.match(/(?:^|\n)\s*(Steps:\s*\d+[\s\S]*)$/i);
  const source = tail ? tail[1] : line;
  for (const part of source.split(/,\s(?=[A-Za-z][\w .\-]*:)/)) {
    const m = part.match(/^\s*([A-Za-z][\w .\-]*):\s*([\s\S]*?)\s*$/);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

function a1111FromText(text) {
  const body = String(text ?? '');
  const cut = body.search(/(?:^|\n)\s*Steps:\s*\d+/i);
  if (cut < 0) return null;
  const settings = parseSettingLine(body.slice(cut));
  if (!settings.steps && !settings.seed && !settings.sampler) return null;
  const head = body.slice(0, cut);
  const negIndex = head.search(/Negative prompt:/i);
  const prompt = (negIndex >= 0 ? head.slice(0, negIndex) : head).trim();
  const negative = negIndex >= 0 ? head.slice(negIndex).replace(/^Negative prompt:\s*/i, '').trim() : '';
  return {
    generator: settings['software'] && /novelai/i.test(settings['software']) ? 'NovelAI' : 'Stable Diffusion WebUI',
    prompt,
    negative,
    model: settings.model ?? settings['model name'] ?? '',
    seed: settings.seed ?? '',
    sampler: settings.sampler ?? '',
    steps: settings.steps ?? '',
    cfg: settings['cfg scale'] ?? settings.cfg ?? '',
    size: settings.size ?? ''
  };
}

function comfyFromJson(data) {
  // API 格式：{ "6": { class_type: "CLIPTextEncode", inputs: { text: "..." } }, ... }
  const nodes = Object.values(data ?? {}).filter((n) => n && typeof n === 'object' && n.class_type);
  if (!nodes.length) return null;
  const texts = [];
  let model = '';
  let seed = '';
  let steps = '';
  let sampler = '';
  let cfg = '';
  for (const node of nodes) {
    const inputs = node.inputs ?? {};
    if (/CLIPTextEncode/i.test(node.class_type) && typeof inputs.text === 'string') texts.push(inputs.text);
    if (/CheckpointLoaderSimple|CheckpointLoader|UNETLoader/i.test(node.class_type)) {
      model = model || String(inputs.ckpt_name ?? inputs.unet_name ?? '');
    }
    if (/KSampler/i.test(node.class_type)) {
      if (inputs.seed !== undefined) seed = String(inputs.seed);
      if (inputs.steps !== undefined) steps = String(inputs.steps);
      if (inputs.sampler_name) sampler = String(inputs.sampler_name);
      if (inputs.cfg !== undefined) cfg = String(inputs.cfg);
    }
  }
  if (!texts.length) return null;
  const NEG = /(lowres|bad anatomy|worst quality|blurry|watermark|extra digit|jpeg artifacts)/i;
  const negative = texts.find((t) => NEG.test(t) && t.length < 400) ?? '';
  const positive = texts.filter((t) => t !== negative).sort((a, b) => b.length - a.length)[0] ?? texts[0];
  return { generator: 'ComfyUI', prompt: positive, negative, model, seed, steps, sampler, cfg, size: '' };
}

function naiFromData(data) {
  // NovelAI 把参数写成 Comment: {"prompt": "...", "uc": "...", "steps": 28, ...}
  const src = data?.Comment ?? data?.comment ?? data?.Description;
  if (typeof src !== 'string') return null;
  const jsonText = src.trim();
  if (!jsonText.startsWith('{')) return null;
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const prompt = String(parsed.prompt ?? '').trim();
  if (!prompt) return null;
  return {
    generator: /nai|novelai/i.test(String(parsed.software ?? data?.Software ?? '')) ? 'NovelAI' : 'NovelAI',
    prompt,
    negative: String(parsed.uc ?? parsed.negative_prompt ?? ''),
    model: String(parsed.model ?? ''),
    seed: String(parsed.seed ?? ''),
    sampler: String(parsed.sampler ?? ''),
    steps: String(parsed.steps ?? ''),
    cfg: String(parsed.scale ?? ''),
    size: parsed.width && parsed.height ? `${parsed.width}x${parsed.height}` : ''
  };
}

function xmpPrompt(xmp) {
  if (!xmp) return null;
  // DALL·E / Midjourney 把提示词写在 dc:description / photoshop:TextLayers / Iptc4xmpExt
  const m = xmp.match(/<dc:description>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i)
    ?? xmp.match(/<photoshop:Headline>([\s\S]*?)<\/photoshop:Headline>/i)
    ?? xmp.match(/<xmp:Description>([\s\S]*?)<\/xmp:Description>/i);
  if (!m) return null;
  const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

function generatorOf(text) {
  for (const [re, name] of GENERATORS) if (re.test(text)) return name;
  return '';
}

/**
 * 读一张图的元数据。永不抛错：认不出来的字段就是空。
 * @returns {{container:string, isAI:boolean|null, generator:string, model:string, prompt:string,
 *   negativePrompt:string, seed:string, sampler:string, steps:string, cfg:string, size:string,
 *   c2pa:boolean, fields:string[], text:string}}
 */
export function readImageMeta(bytes) {
  const container = sniffContainer(bytes);
  let fields = {};
  try {
    if (container === 'png') fields = pngTextFields(bytes);
    else if (container === 'jpeg') fields = jpegFields(bytes);
    else if (container === 'webp') fields = webpFields(bytes);
  } catch {
    fields = {};
  }

  const keys = Object.keys(fields).filter((k) => !k.startsWith('__'));
  const blob = keys.map((k) => `${k}=${String(fields[k] ?? '')}`).join('\n');
  const c2pa = Boolean(fields.__c2pa) || /\bc2pa\b|contentauth/i.test(str(bytes, 0, Math.min(bytes.length, 4096)));

  let info = null;
  // ① A1111 / Forge / SD.Next：parameters 字段是「提示词 + 参数尾巴」，最直白，先认它
  const paramText = fields.parameters ?? fields.Parameters ?? '';
  if (paramText) info = a1111FromText(paramText);
  // ② ComfyUI：prompt 字段是 JSON
  if (!info) {
    const comfyRaw = fields.prompt ?? fields.workflow ?? fields.Prompt;
    if (typeof comfyRaw === 'string' && comfyRaw.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(comfyRaw);
        info = comfyFromJson(parsed?.prompt ?? parsed) ?? comfyFromJson(parsed);
      } catch {
        // 不是 JSON 就不是 ComfyUI
      }
    }
  }
  // ③ NovelAI：Comment 是 JSON
  if (!info) info = naiFromData(fields);
  // ④ 兜底：整个元数据里像参数尾巴的，多半也带提示词
  if (!info && /Steps:\s*\d+/i.test(blob)) info = a1111FromText(blob);
  // ⑤ XMP（DALL·E / Midjourney / Adobe）
  const xmpText = typeof fields.__xmp === 'string' ? fields.__xmp : '';
  if (!info && xmpText) {
    const prompt = xmpPrompt(xmpText);
    if (prompt) info = { generator: generatorOf(xmpText) || '', prompt, negative: '', model: '', seed: '', sampler: '', steps: '', cfg: '', size: '' };
  }

  const software = String(fields.Software ?? fields.software ?? '');
  const blobAll = `${blob}\n${xmpText}`;
  const generator = info?.generator || generatorOf(`${software}\n${blobAll}`) || '';
  const aiMarker = AI_SOFTWARE.test(software)
    || Boolean(generator)
    || /Steps:\s*\d+,\s*Sampler:/i.test(blobAll)
    || c2pa && /dall|openai|midjourney|adobe firefly|google/i.test(blobAll);

  const prompt = String(info?.prompt ?? '');
  return {
    container,
    isAI: aiMarker ? true : (keys.length || c2pa ? false : null),
    generator,
    model: String(info?.model ?? ''),
    prompt,
    negativePrompt: String(info?.negative ?? ''),
    seed: String(info?.seed ?? ''),
    sampler: String(info?.sampler ?? ''),
    steps: String(info?.steps ?? ''),
    cfg: String(info?.cfg ?? ''),
    size: String(info?.size ?? ''),
    c2pa,
    fields: keys,
    text: prompt || String(fields.parameters ?? fields.Comment ?? '').slice(0, 800)
  };
}
