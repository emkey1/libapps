// Copyright 2026 The iSH-AOK Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/**
 * @fileoverview The basics of kitty's terminal graphics protocol.
 *
 * https://sw.kovidgoyal.net/kitty/graphics-protocol/
 *
 * Supported: transmitting an image directly in the escape code (t=d), in one
 * piece or in chunks (m=1); PNG (f=100) and raw RGB/RGBA (f=24, f=32), zlib
 * compressed (o=z) or not; transmit (a=t), transmit and display (a=T), display
 * a stored image (a=p), query (a=q) and delete (a=d, by id or all); sizing in
 * cells (c, r); the cursor policy (C); replies, and suppressing them (q).
 *
 * Not supported, and refused with an error so a client can fall back: images
 * read from a file or shared memory (t=f, t=t, t=s), Unicode placeholders
 * (U=1), animation frames (a=f, a=a, a=c). Ignored: source rectangles (x, y,
 * w, h), pixel offsets (X, Y), z-index and relative placements.
 *
 * An image is drawn where the cursor is, a slice of it on each row it covers
 * (see place_): it scrolls with the text, and goes with the rows when they are
 * cleared.
 */

/**
 * @param {!hterm.Terminal} terminal
 * @constructor
 */
hterm.KittyGraphics = function(terminal) {
  this.terminal_ = terminal;
  // Every image drawn, for deletion. Rows scrolled out of view are not in the
  // document, so a query of the document would miss theirs.
  this.placements_ = [];
  this.reset();
};

/**
 * Most image data kept for later display (a=t, then a=p), in bytes. The oldest
 * images go first when a new one would pass it.
 */
hterm.KittyGraphics.maxStoredBytes = 64 * 1024 * 1024;

/**
 * Most images drawn that are remembered for deletion. Past it the oldest are
 * left to their rows, as text is.
 */
hterm.KittyGraphics.maxPlacements = 1000;

/**
 * Reset the graphics state: stored images, and a transfer still in progress.
 * The images already on screen stay; they are part of the rows.
 */
hterm.KittyGraphics.prototype.reset = function() {
  this.images_ = new Map();
  this.storedBytes_ = 0;
  this.pending_ = null;
  this.nextId_ = 0x7fff0000;
};

/**
 * Handle the body of one APC G sequence: everything after the 'G'.
 *
 * @param {string} body The control data, then ';' and the payload.
 */
hterm.KittyGraphics.prototype.command = function(body) {
  const semi = body.indexOf(';');
  const control = semi == -1 ? body : body.slice(0, semi);
  const payload = semi == -1 ? '' : body.slice(semi + 1);
  const keys = hterm.KittyGraphics.parseControl(control);

  // A chunk after the first carries only m (and perhaps q); the rest comes
  // from the first chunk.
  if (this.pending_) {
    const pending = this.pending_;
    pending.payload.push(payload);
    if (keys.m == '1') {
      return;
    }
    this.pending_ = null;
    this.finish_(pending.keys, pending.payload.join(''));
    return;
  }

  if (keys.m == '1') {
    this.pending_ = {keys, payload: [payload]};
    return;
  }
  this.finish_(keys, payload);
};

/**
 * Split "a=T,f=100,i=1" into its keys.
 *
 * @param {string} control
 * @return {!Object<string, string>}
 */
hterm.KittyGraphics.parseControl = function(control) {
  const keys = {};
  for (const pair of control.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) {
      keys[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return keys;
};

/**
 * Act on a complete command.
 *
 * @param {!Object<string, string>} keys
 * @param {string} payload The base64 payload, all chunks joined.
 */
hterm.KittyGraphics.prototype.finish_ = function(keys, payload) {
  const action = keys.a || 't';
  try {
    switch (action) {
      case 'q':
        // Everything a transmission would be checked for, nothing kept.
        this.decode_(keys, payload);
        this.reply_(keys, 'OK');
        break;
      case 't':
      case 'T': {
        const image = this.decode_(keys, payload);
        const id = this.assignId_(keys);
        this.store_(id, image);
        if (action == 'T') {
          this.place_(image, keys);
        }
        this.reply_(keys, 'OK');
        break;
      }
      case 'p': {
        const image = this.images_.get(Number(keys.i || 0));
        if (!image) {
          throw new hterm.KittyGraphics.Error(
              'ENOENT', 'no image with that id');
        }
        this.place_(image, keys);
        this.reply_(keys, 'OK');
        break;
      }
      case 'd':
        // Deletion never replies.
        this.delete_(keys);
        break;
      default:
        throw new hterm.KittyGraphics.Error(
            'EINVAL', `unsupported action ${action}`);
    }
  } catch (e) {
    if (e instanceof hterm.KittyGraphics.Error) {
      this.reply_(keys, `${e.code}:${e.message}`);
    } else {
      throw e;
    }
  }
};

/**
 * An error to report back to the client.
 *
 * @param {string} code A POSIX-style code, as kitty sends.
 * @param {string} message
 * @constructor
 */
hterm.KittyGraphics.Error = function(code, message) {
  this.code = code;
  this.message = message;
};

/**
 * Work out what a transmission holds, without placing it.
 *
 * @param {!Object<string, string>} keys
 * @param {string} payload
 * @return {!Object} The image: format, size in pixels and its bytes.
 */
hterm.KittyGraphics.prototype.decode_ = function(keys, payload) {
  const medium = keys.t || 'd';
  if (medium != 'd') {
    throw new hterm.KittyGraphics.Error(
        'EINVAL', 'only direct transmission (t=d) is supported');
  }
  if (keys.U == '1') {
    throw new hterm.KittyGraphics.Error(
        'EINVAL', 'Unicode placeholders are not supported');
  }
  const format = Number(keys.f || 32);
  if (format != 24 && format != 32 && format != 100) {
    throw new hterm.KittyGraphics.Error(
        'EINVAL', `unsupported format ${format}`);
  }
  const compressed = keys.o == 'z';
  if (keys.o && !compressed) {
    throw new hterm.KittyGraphics.Error(
        'EINVAL', `unsupported compression ${keys.o}`);
  }
  if (compressed && typeof DecompressionStream === 'undefined') {
    throw new hterm.KittyGraphics.Error(
        'EINVAL', 'zlib compression is not available on this system');
  }

  let bytes;
  try {
    bytes = lib.codec.stringToCodeUnitArray(atob(payload));
  } catch (e) {
    throw new hterm.KittyGraphics.Error('EINVAL', 'payload is not base64');
  }

  let width;
  let height;
  if (format == 100) {
    if (compressed) {
      // The size is in the PNG header, which is inside the compressed data,
      // and the image has to be placed before the text after it is drawn.
      throw new hterm.KittyGraphics.Error(
          'EINVAL', 'compressed PNG is not supported; send the PNG as is');
    }
    const size = hterm.KittyGraphics.pngSize(bytes);
    if (!size) {
      throw new hterm.KittyGraphics.Error('EBADPNG', 'not a PNG image');
    }
    [width, height] = size;
  } else {
    width = Number(keys.s || 0);
    height = Number(keys.v || 0);
    if (!(width > 0) || !(height > 0)) {
      throw new hterm.KittyGraphics.Error(
          'EINVAL', 'raw pixel data needs its width (s) and height (v)');
    }
    if (!compressed && bytes.length < width * height * (format / 8)) {
      throw new hterm.KittyGraphics.Error(
          'ENODATA', 'not enough pixel data for the size given');
    }
  }
  if (width > 10000 || height > 10000) {
    throw new hterm.KittyGraphics.Error('EINVAL', 'image is too large');
  }
  return {format, width, height, bytes, compressed};
};

/**
 * The width and height in a PNG's header, or null if it is not a PNG.
 *
 * @param {!Uint8Array} bytes
 * @return {?Array<number>}
 */
hterm.KittyGraphics.pngSize = function(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] != b)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? [width, height] : null;
};

/**
 * The id a transmission is stored under: its own i, or one assigned for an
 * image number (I).
 *
 * @param {!Object<string, string>} keys
 * @return {number}
 */
hterm.KittyGraphics.prototype.assignId_ = function(keys) {
  if (keys.i) {
    return Number(keys.i);
  }
  if (keys.I) {
    keys.i = String(++this.nextId_);
    return Number(keys.i);
  }
  return 0;
};

/**
 * Keep an image for a later a=p. Images without an id can't be asked for
 * again, so they are not kept.
 *
 * @param {number} id
 * @param {!Object} image
 */
hterm.KittyGraphics.prototype.store_ = function(id, image) {
  if (!id) {
    return;
  }
  this.forget_(id);
  this.images_.set(id, image);
  this.storedBytes_ += image.bytes.length;
  for (const [oldId, old] of this.images_) {
    if (this.storedBytes_ <= hterm.KittyGraphics.maxStoredBytes ||
        oldId == id) {
      break;
    }
    this.images_.delete(oldId);
    this.storedBytes_ -= old.bytes.length;
  }
};

/**
 * Drop a stored image.
 *
 * @param {number} id
 */
hterm.KittyGraphics.prototype.forget_ = function(id) {
  const old = this.images_.get(id);
  if (old) {
    this.storedBytes_ -= old.bytes.length;
    this.images_.delete(id);
  }
};

/**
 * Draw an image at the cursor.
 *
 * Each row the image covers shows its own slice of it, as a background layer
 * on the row. Nothing is added inside the row: hterm writes text by editing the
 * row's child nodes and would overwrite an element there, while a row's style
 * survives writes, scrolls with it into the scrollback, and is cleared with it.
 *
 * @param {!Object} image
 * @param {!Object<string, string>} keys
 */
hterm.KittyGraphics.prototype.place_ = function(image, keys) {
  const terminal = this.terminal_;
  const cell = terminal.scrollPort_.characterSize;
  const ratio = terminal.getDevicePixelRatio();

  // The size on screen: the image's own pixels as device pixels, unless the
  // client gave it a size in cells. One of the two keeps the aspect ratio.
  const cols = Number(keys.c || 0);
  const rows = Number(keys.r || 0);
  let width = image.width / ratio;
  let height = image.height / ratio;
  if (cols > 0 && rows > 0) {
    width = cols * cell.width;
    height = rows * cell.height;
  } else if (cols > 0) {
    width = cols * cell.width;
    height = width * image.height / image.width;
  } else if (rows > 0) {
    height = rows * cell.height;
    width = height * image.width / image.height;
  }
  const spanCols = cols > 0 ? cols : Math.max(1, Math.ceil(width / cell.width));
  const spanRows = rows > 0 ?
      rows : Math.max(1, Math.ceil(height / cell.height));

  // Down to the image's last row, scrolling as needed, collecting each row it
  // covers on the way.
  const startColumn = terminal.getCursorColumn();
  const rowNodes = [];
  for (let i = 0; i < spanRows; ++i) {
    if (i > 0) {
      terminal.lineFeed();
    }
    rowNodes.push(terminal.getRowNode(
        terminal.scrollbackRows_.length + terminal.getCursorRow()));
  }

  const placement = {
    id: Number(keys.i || 0),
    url: null,
    rows: rowNodes,
    left: startColumn * cell.width,
    rowHeight: cell.height,
    width,
    height,
  };
  rowNodes.forEach((row, index) => {
    row.kittyLayers_ = row.kittyLayers_ || [];
    row.kittyLayers_.push({placement, index});
  });
  this.placements_.push(placement);
  if (this.placements_.length > hterm.KittyGraphics.maxPlacements) {
    this.placements_.shift();
  }
  this.imageUrl_(image).then((url) => {
    placement.url = url;
    placement.rows.forEach((row) => hterm.KittyGraphics.paintRow(row));
  }, () => {});

  if (keys.C != '1') {
    terminal.setCursorColumn(
        Math.min(startColumn + spanCols, terminal.screenSize.width - 1));
  } else {
    // The cursor stays where the image starts. (cursorUp takes 0 as 1.)
    if (spanRows > 1) {
      terminal.cursorUp(spanRows - 1);
    }
    terminal.setCursorColumn(startColumn);
  }
};

/**
 * Set a row's background to the image slices it holds.
 *
 * @param {!Element} row
 */
hterm.KittyGraphics.paintRow = function(row) {
  const layers = (row.kittyLayers_ || []).filter((l) => l.placement.url);
  if (!layers.length) {
    row.style.backgroundImage = '';
    row.style.backgroundSize = '';
    row.style.backgroundPosition = '';
    row.style.backgroundRepeat = '';
    return;
  }
  // The first layer is drawn on top, and later images belong on top.
  layers.reverse();
  row.style.backgroundImage =
      layers.map((l) => `url("${l.placement.url}")`).join(', ');
  row.style.backgroundSize =
      layers.map((l) => `${l.placement.width}px ${l.placement.height}px`)
          .join(', ');
  row.style.backgroundPosition = layers.map((l) =>
      `${l.placement.left}px ${-l.index * l.placement.rowHeight}px`)
      .join(', ');
  row.style.backgroundRepeat = layers.map(() => 'no-repeat').join(', ');
};

/**
 * A URL for an image's pixels: the PNG itself, or raw pixels drawn to a
 * canvas and saved as one.
 *
 * @param {!Object} image
 * @return {!Promise<string>}
 */
hterm.KittyGraphics.prototype.imageUrl_ = async function(image) {
  if (image.format == 100) {
    return URL.createObjectURL(new Blob([image.bytes], {type: 'image/png'}));
  }
  const bytes = image.compressed ?
      await hterm.KittyGraphics.inflate(image.bytes) : image.bytes;
  const count = image.width * image.height;
  if (bytes.length < count * (image.format / 8)) {
    throw new Error('not enough pixel data');
  }
  const canvas = this.terminal_.getDocument().createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(image.width, image.height);
  if (image.format == 32) {
    pixels.data.set(bytes.subarray(0, count * 4));
  } else {
    for (let i = 0; i < count; ++i) {
      pixels.data[i * 4] = bytes[i * 3];
      pixels.data[i * 4 + 1] = bytes[i * 3 + 1];
      pixels.data[i * 4 + 2] = bytes[i * 3 + 2];
      pixels.data[i * 4 + 3] = 255;
    }
  }
  context.putImageData(pixels, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve));
  if (!blob) {
    throw new Error('could not encode the image');
  }
  return URL.createObjectURL(blob);
};

/**
 * Undo zlib compression.
 *
 * @param {!Uint8Array} bytes
 * @return {!Promise<!Uint8Array>}
 */
hterm.KittyGraphics.inflate = async function(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(
      new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/**
 * Delete images (a=d). Lowercase removes them from the screen; uppercase
 * also forgets the stored data.
 *
 * @param {!Object<string, string>} keys
 */
hterm.KittyGraphics.prototype.delete_ = function(keys) {
  const what = keys.d || 'a';
  const forget = what == what.toUpperCase();
  let matches;
  switch (what.toLowerCase()) {
    case 'a':
      matches = () => true;
      if (forget) {
        this.reset();
      }
      break;
    case 'i': {
      const id = Number(keys.i || 0);
      matches = (placement) => placement.id == id;
      if (forget) {
        this.forget_(id);
      }
      break;
    }
    default:
      return;
  }
  this.placements_ = this.placements_.filter((placement) => {
    if (!matches(placement)) {
      return true;
    }
    for (const row of placement.rows) {
      row.kittyLayers_ =
          row.kittyLayers_.filter((l) => l.placement !== placement);
      hterm.KittyGraphics.paintRow(row);
    }
    if (placement.url) {
      URL.revokeObjectURL(placement.url);
    }
    return false;
  });
};

/**
 * Answer the client, as kitty would: only when the command named an image,
 * and as q asks.
 *
 * @param {!Object<string, string>} keys
 * @param {string} message 'OK', or 'CODE:message'.
 */
hterm.KittyGraphics.prototype.reply_ = function(keys, message) {
  if (!keys.i && !keys.I) {
    return;
  }
  const quiet = Number(keys.q || 0);
  if (quiet >= 2 || (quiet == 1 && message == 'OK')) {
    return;
  }
  let ids = `i=${keys.i || 0}`;
  if (keys.I) {
    ids += `,I=${keys.I}`;
  }
  if (keys.p) {
    ids += `,p=${keys.p}`;
  }
  this.terminal_.io.sendString(`\x1b_G${ids};${message}\x1b\\`);
};
