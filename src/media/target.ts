export interface Size {
  width: number;
  height: number;
}

export interface SizeRequest {
  width: number;
  height: number;
  fps?: number;
}

export interface NegotiatedSize {
  width: number;
  height: number;
  /** True when the encoder has to rescale from the capture size. */
  scaled: boolean;
}

/** H.264 4:2:0 needs even dimensions on both axes. */
function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Choose the encode size for a controller.
 *
 * The frame keeps the captured desktop's aspect ratio. Cropping would hide part
 * of the host's screen and stretching would distort it, so the result is the
 * largest rectangle with the host's shape that fits the controller's viewport:
 * a controller at least as large as the host (a PC on a 4K monitor) gets the
 * native size and pays nothing for the trip, while a 2560x1440 phone or a tablet
 * gets a frame that fills its viewport instead of a 4K stream it must discard.
 */
export function negotiateSize(host: Size, client?: SizeRequest): NegotiatedSize {
  const hostWidth = even(host.width);
  const hostHeight = even(host.height);
  const native = { width: hostWidth, height: hostHeight, scaled: false };
  if (!client || client.width <= 0 || client.height <= 0) return native;
  if (client.width >= hostWidth && client.height >= hostHeight) return native;

  const scale = Math.min(client.width / hostWidth, client.height / hostHeight);
  const width = even(hostWidth * scale);
  const height = even(hostHeight * scale);
  if (width >= hostWidth || height >= hostHeight) return native;
  return { width, height, scaled: true };
}

/**
 * Bitrate that matches a scaled-down frame.
 *
 * The presets are calibrated for the capture resolution, so shrinking the frame
 * without shrinking the budget would waste bandwidth on a picture that no longer
 * has that many pixels to describe. Scaling linearly with the pixel count
 * under-serves medium sizes though — 1080p60 at a quarter of the 4K budget looks
 * soft on text — so the result never drops below a fixed fraction of the preset.
 */
/**
 * Cap a size so a constrained bitrate can actually describe it.
 *
 * Bits per pixel per frame is what the eye sees as "mosaic vs crisp":
 * 2560x1440@60 squeezed through a measured 5 Mbps uplink leaves ~0.02
 * bits/px — no encoder setting makes that look like 4K, it just turns
 * into blocks, while the same 5 Mbps at ~1365x768 stays recognisable.
 * A smaller sharp picture also serialises faster on a thin uplink,
 * which is where the "200 ms" feel comes from at high resolutions.
 *
 * Only meant for bitrates that were cut by the network (or the relay
 * budget); an unconstrained preset keeps the negotiated size untouched
 * (the caller decides when this applies).
 */
export function capSizeForBitrate(size: Size, kbps: number, fps: number, minBpp = 0.1): Size {
  if (kbps <= 0 || fps <= 0) return size;
  const maxPixels = (kbps * 1000) / (fps * minBpp);
  const pixels = size.width * size.height;
  if (pixels <= maxPixels) return size;
  const scale = Math.sqrt(maxPixels / pixels);
  return {
    width: even(size.width * scale),
    height: even(size.height * scale),
  };
}

/**
 * Pick encode geometry for a bitrate the network actually sustains.
 *
 * Pixels first, frames second: when the pixel budget at the requested
 * fps would crush the picture below half its size, halving the frame
 * rate doubles the bits per frame and buys back most of the pixels.
 * For desktop content (text!) a clear 30 fps beats a 60 fps smear at
 * the same bitrate every time; motion-heavy content on a healthy link
 * never reaches this code path.
 */
export function fitGeometryForBitrate(
  size: Size,
  kbps: number,
  fps: number,
): { width: number; height: number; fps: number } {
  const capped = capSizeForBitrate(size, kbps, fps);
  const crushed = capped.width * capped.height < size.width * size.height * 0.5;
  if (crushed && fps > 30) {
    const at30 = capSizeForBitrate(size, kbps, 30);
    return { width: at30.width, height: at30.height, fps: 30 };
  }
  return { width: capped.width, height: capped.height, fps };
}

export function scaleBitrate(baseKbps: number, host: Size, target: Size, minRatio = 0.4): number {
  const hostPixels = Math.max(1, host.width * host.height);
  const targetPixels = Math.max(1, target.width * target.height);
  const ratio = Math.min(1, targetPixels / hostPixels);
  return Math.max(2500, Math.round(baseKbps * Math.max(ratio, minRatio)));
}
