import {
  FroglightError,
  compileScene,
  logicalIdOf,
  createDefaultSurfaceObjectTypeRegistry,
  SURFACE_OBJECT_TYPES,
  baseOf,
  frameBounds,
  isNavigablePage,
  sha256Hex,
  templateBackgroundDrawItems,
  type DrawItem,
  type PdfExportProvider,
  type PdfExportRequest,
  type PdfExportWarning,
  type SurfaceModel,
} from '@froglight/foundation';
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  StandardFonts,
  degrees,
  rgb,
  type PDFPage,
  type RGB,
} from 'pdf-lib';

type ExportErrorCode =
  | 'PDF_RESOURCE_LIMIT'
  | 'PDF_FEATURE_UNSUPPORTED'
  | 'PDF_ASSET_INTEGRITY'
  | 'PDF_RENDER_CANCELLED';

function exportError(code: ExportErrorCode, message: string, cause?: unknown): FroglightError {
  return new FroglightError(code, message, cause === undefined ? undefined : { cause });
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw exportError('PDF_RENDER_CANCELLED', 'PDF export was cancelled');
}

function color(value: unknown, fallback = rgb(0.22, 0.21, 0.18)): RGB {
  if (typeof value !== 'string') return fallback;
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex !== null) {
    const integer = Number.parseInt(hex[1]!, 16);
    return rgb(((integer >> 16) & 255) / 255, ((integer >> 8) & 255) / 255, (integer & 255) / 255);
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(value);
  return rgba === null
    ? fallback
    : rgb(Number(rgba[1]) / 255, Number(rgba[2]) / 255, Number(rgba[3]) / 255);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function topToPdf(pageHeight: number, y: number): number {
  return pageHeight - y;
}

async function drawSurface(
  document: PDFDocument,
  page: PDFPage,
  surface: SurfaceModel,
  request: PdfExportRequest,
  pageId: string,
  warnings: PdfExportWarning[],
): Promise<void> {
  const pageHeight = page.getHeight();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const inkItems = new Map<string, DrawItem[]>();
  const emittedInk = new Set<string>();
  for (const item of compileScene(surface, createDefaultSurfaceObjectTypeRegistry())) {
    if (item.kind !== 'stroke') continue;
    const id = item.objectId;
    const list = inkItems.get(id) ?? [];
    list.push(item);
    inkItems.set(id, list);
  }
  for (const objectId of surface.order) {
    assertActive(request.signal);
    const object = surface.objects[objectId];
    if (object === undefined) continue;
    const opacity = Math.max(0, Math.min(1, finite(object.opacity, 1)));
    if (object.type === SURFACE_OBJECT_TYPES.stroke) {
      const inkId = logicalIdOf(object) ?? objectId;
      if (emittedInk.has(inkId)) continue;
      emittedInk.add(inkId);
      // Compile the logical source once through the same Surface contract
      // as Canvas. Do not redraw raw samples as constant-width segments.
      for (const item of inkItems.get(inkId) ?? []) {
        if (item.kind !== 'stroke') continue;
        const contours = item.contours ?? [item.outline];
        const cx = item.bounds.x + item.bounds.width / 2;
        const cy = item.bounds.y + item.bounds.height / 2;
        const cos = Math.cos(item.rotation), sin = Math.sin(item.rotation);
        const coordinate = (p: { x: number; y: number }) => {
          const dx = p.x - cx, dy = p.y - cy;
          return `${cx + dx * cos - dy * sin} ${cy + dx * sin + dy * cos}`;
        };
        const path = contours.filter(ring => ring.length >= 3).map(ring =>
          `M ${coordinate(ring[0]!)} ${ring.slice(1).map(p => `L ${coordinate(p)}`).join(' ')} Z`,
        ).join(' ');
        if (path !== '') page.drawSvgPath(path, { x: 0, y: pageHeight, color: color(item.color), opacity: item.opacity ?? 1, borderWidth: 0 });
      }
      continue;
    }
    if (object.type === SURFACE_OBJECT_TYPES.line) {
      page.drawLine({
        start: { x: finite(object.x, 0), y: topToPdf(pageHeight, finite(object.y, 0)) },
        end: { x: finite(object.x2, 0), y: topToPdf(pageHeight, finite(object.y2, 0)) },
        thickness: finite(object.width, 1),
        color: color(object.color),
        opacity,
      });
      continue;
    }
    if (object.type === SURFACE_OBJECT_TYPES.text && typeof object.text === 'string') {
      const size = finite(object.size, 16);
      const x = finite(object.x, 0);
      const y = topToPdf(pageHeight, finite(object.y, 0)) - size;
      try {
        page.drawText(object.text, {
          x,
          y,
          size,
          font,
          color: color(object.color),
          opacity,
          ...(typeof object.rotation === 'number' ? { rotate: degrees(-object.rotation * 180 / Math.PI) } : {}),
        });
      } catch {
        // Standard Helvetica cannot encode all Unicode. Preserve a stable
        // visual footprint and report the fidelity loss instead of aborting
        // or silently dropping the object.
        page.drawRectangle({
          x,
          y,
          width: Math.max(size * 0.6, [...object.text].length * size * 0.6),
          height: size,
          color: color(object.color),
          opacity: Math.min(opacity, 0.2),
        });
        warnings.push({
          code: 'EXPORT_TEXT_FALLBACK',
          pageId,
          detail: 'Surface text used a deterministic visual fallback because the export font could not encode it',
        });
      }
      continue;
    }
    if (object.type === SURFACE_OBJECT_TYPES.rectangle || object.type === SURFACE_OBJECT_TYPES.ellipse) {
      const x = finite(object.x, 0);
      const y = finite(object.y, 0);
      const width = finite(object.width, 0);
      const height = finite(object.height, 0);
      const options = {
        x,
        y: topToPdf(pageHeight, y) - height,
        width,
        height,
        color: color(object.fill, rgb(0.9, 0.9, 0.9)),
        opacity,
      };
      if (object.type === SURFACE_OBJECT_TYPES.rectangle) page.drawRectangle(options);
      else page.drawEllipse({
        x: x + width / 2,
        y: topToPdf(pageHeight, y) - height / 2,
        xScale: width / 2,
        yScale: height / 2,
        color: options.color,
        opacity,
      });
      continue;
    }
    if (
      object.type === SURFACE_OBJECT_TYPES.image &&
      typeof object.src === 'string' &&
      typeof object.sha256 === 'string'
    ) {
      const bytes = await request.assets.read(object.src);
      if ((await sha256Hex(bytes)) !== object.sha256) {
        throw exportError('PDF_ASSET_INTEGRITY', `image asset hash mismatch on page ${pageId}`);
      }
      let image;
      try {
        image = bytes[0] === 0xff && bytes[1] === 0xd8
          ? await document.embedJpg(bytes)
          : await document.embedPng(bytes);
      } catch (error) {
        throw exportError('PDF_FEATURE_UNSUPPORTED', `image format is unsupported on page ${pageId}`, error);
      }
      page.drawImage(image, {
        x: finite(object.x, 0),
        y: topToPdf(pageHeight, finite(object.y, 0)) - finite(object.height, image.height),
        width: finite(object.width, image.width),
        height: finite(object.height, image.height),
        opacity,
      });
      continue;
    }
    warnings.push({
      code: 'EXPORT_FEATURE_DROPPED',
      pageId,
      detail: `Surface object ${object.type} is unavailable to this export provider`,
    });
  }
}

function drawTemplateItems(page: PDFPage, items: readonly DrawItem[]): void {
  const pageHeight = page.getHeight();
  for (const item of items) {
    if (item.kind === 'line') {
      page.drawLine({
        start: { x: item.x, y: topToPdf(pageHeight, item.y) },
        end: { x: item.x2, y: topToPdf(pageHeight, item.y2) },
        thickness: item.width,
        color: color(item.color, rgb(0.38, 0.49, 0.74)),
        opacity: 0.3,
      });
    } else if (item.kind === 'ellipse') {
      page.drawEllipse({
        x: item.bounds.x + item.bounds.width / 2,
        y: topToPdf(pageHeight, item.bounds.y) - item.bounds.height / 2,
        xScale: item.bounds.width / 2,
        yScale: item.bounds.height / 2,
        color: color(item.fill, rgb(0.38, 0.49, 0.74)),
        opacity: 0.3,
      });
    }
  }
}

async function addPreservingPage(
  output: PDFDocument,
  request: PdfExportRequest,
  pageId: string,
  warnings: PdfExportWarning[],
): Promise<void> {
  const entry = request.notebook.pages[pageId];
  if (!isNavigablePage(entry)) return;
  const base = baseOf(entry);
  let page: PDFPage;
  if (base.kind === 'pdf-page') {
    const sourceBytes = await request.assets.read(base.asset.path);
    if ((await sha256Hex(sourceBytes)) !== base.asset.sha256) {
      throw exportError('PDF_ASSET_INTEGRITY', `PDF asset hash mismatch on page ${pageId}`);
    }
    try {
      const source = await PDFDocument.load(sourceBytes, { updateMetadata: false });
      if (base.pageIndex >= source.getPageCount()) {
        throw exportError('PDF_FEATURE_UNSUPPORTED', `source page ${base.pageIndex} is unavailable`);
      }
      const sourcePage = source.getPage(base.pageIndex);
      const mediaBox = sourcePage.getMediaBox();
      const cropBox = sourcePage.getCropBox();
      const rotation = ((sourcePage.getRotation().angle % 360) + 360) % 360;
      const userUnit = sourcePage.node
        .lookupMaybe(PDFName.of('UserUnit'), PDFNumber)
        ?.asNumber() ?? 1;
      const hasNontrivialCrop =
        Math.abs(cropBox.x - mediaBox.x) > 1e-6 ||
        Math.abs(cropBox.y - mediaBox.y) > 1e-6 ||
        Math.abs(cropBox.width - mediaBox.width) > 1e-6 ||
        Math.abs(cropBox.height - mediaBox.height) > 1e-6;
      if (rotation !== 0 || Math.abs(userUnit - 1) > 1e-6 || hasNontrivialCrop) {
        throw exportError(
          'PDF_FEATURE_UNSUPPORTED',
          `preserving export cannot yet align rotated, cropped, or UserUnit source page ${base.pageIndex}`,
        );
      }
      [page] = await output.copyPages(source, [base.pageIndex]);
      output.addPage(page);
    } catch (error) {
      if (error instanceof FroglightError) throw error;
      throw exportError('PDF_FEATURE_UNSUPPORTED', `source page cannot be preserved on page ${pageId}`, error);
    }
    warnings.push({
      code: 'EXPORT_FEATURE_DROPPED',
      pageId,
      detail: 'Source outlines, forms, and non-page document structures are not preserved by pdf-lib',
    });
  } else {
    const bounds = frameBounds(entry.surface.frame);
    if (bounds === null) throw exportError('PDF_FEATURE_UNSUPPORTED', `page ${pageId} is not bounded`);
    page = output.addPage([bounds.width, bounds.height]);
    page.drawRectangle({ x: 0, y: 0, width: bounds.width, height: bounds.height, color: rgb(1, 1, 1) });
    drawTemplateItems(page, templateBackgroundDrawItems(base.template, bounds.width, bounds.height));
  }
  await drawSurface(output, page, entry.surface, request, pageId, warnings);
}

async function addFlattenedPage(
  output: PDFDocument,
  request: PdfExportRequest,
  pageId: string,
  dpi: number,
  warnings: PdfExportWarning[],
): Promise<void> {
  const entry = request.notebook.pages[pageId];
  if (!isNavigablePage(entry)) return;
  const bounds = frameBounds(entry.surface.frame);
  if (bounds === null) throw exportError('PDF_FEATURE_UNSUPPORTED', `page ${pageId} is not bounded`);
  const pixelWidth = Math.ceil(bounds.width * dpi / 72);
  const pixelHeight = Math.ceil(bounds.height * dpi / 72);
  if (pixelWidth > 16_384 || pixelHeight > 16_384 || pixelWidth * pixelHeight > 64_000_000) {
    throw exportError('PDF_RESOURCE_LIMIT', `flattened page ${pageId} exceeds export raster limits`);
  }
  if (request.renderFlattenedPage === undefined) {
    throw exportError('PDF_FEATURE_UNSUPPORTED', 'flattened export requires a page appearance renderer');
  }
  const imageBytes = await request.renderFlattenedPage(pageId, dpi, request.signal);
  let image;
  try {
    image = imageBytes[0] === 0xff && imageBytes[1] === 0xd8
      ? await output.embedJpg(imageBytes)
      : await output.embedPng(imageBytes);
  } catch (error) {
    throw exportError('PDF_FEATURE_UNSUPPORTED', `flattened renderer returned an unsupported image for ${pageId}`, error);
  }
  const page = output.addPage([bounds.width, bounds.height]);
  page.drawImage(image, { x: 0, y: 0, width: bounds.width, height: bounds.height });
  warnings.push({
    code: 'EXPORT_FLATTENED',
    pageId,
    detail: 'Source text, vectors, links, and outlines are rasterized in compatibility output',
  });
}

export class PdfLibExportProvider implements PdfExportProvider {
  async exportNotebook(request: PdfExportRequest): Promise<{
    readonly bytes: Uint8Array;
    readonly warnings: readonly PdfExportWarning[];
  }> {
    assertActive(request.signal);
    const dpi = request.rasterDpi ?? 150;
    if (request.mode === 'flatten' && (!Number.isFinite(dpi) || dpi < 72 || dpi > 300)) {
      throw exportError('PDF_RESOURCE_LIMIT', 'flattened export rasterDpi must be between 72 and 300');
    }
    const output = await PDFDocument.create();
    const warnings: PdfExportWarning[] = [];
    for (const pageId of request.notebook.pageOrder) {
      assertActive(request.signal);
      if (request.mode === 'preserve') {
        await addPreservingPage(output, request, pageId, warnings);
      } else {
        await addFlattenedPage(output, request, pageId, dpi, warnings);
      }
    }
    assertActive(request.signal);
    return {
      bytes: await output.save({ useObjectStreams: false, addDefaultPage: false }),
      warnings,
    };
  }
}
