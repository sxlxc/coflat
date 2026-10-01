import { EditorSelection, type EditorState, Facet, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { destinationSyntax, type SyntaxNode } from "pandocmd-cst";
import { CSS } from "../../core/constants/css-classes";
import { isSafeUrl } from "../../core/lib/url-utils";
import { getPandocTree } from "./pandoc-cst-field";

type ImageResourceReader = (path: string) => Promise<Blob>;

export const imageResourceFacet = Facet.define<ImageResourceReader | undefined, ImageResourceReader | undefined>({
  combine: (values) => values.find((value) => value !== undefined),
});

function child(node: SyntaxNode, kind: SyntaxNode["kind"]): SyntaxNode | undefined {
  return [...node.children()].find((value) => value.kind === kind);
}

/** Only a standalone image owns block source rows. */
export function isBlockImage(node: SyntaxNode): boolean {
  return (node.kind === "Image" || node.kind === "ImageReferenceCandidate")
    && node.parent?.kind === "Paragraph"
    && [...node.parent.children()].every((value) => value.from === node.from
      || value.kind === "SoftBreak" || value.kind === "Space");
}

function unquote(value: string): string {
  return (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'")) ? value.slice(1, -1) : value;
}

function decodedDestination(ownerDocument: Document, source: string): string {
  // Decode only within the CST destination, in one pass so escaped ampersands
  // and entity results are not interpreted a second time.
  return source.replace(/\\[!-/:-@[-`{-~]|&(?:#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (encoded) => {
    if (encoded.startsWith("\\")) return encoded.slice(1);
    const decoder = ownerDocument.createElement("textarea");
    decoder.innerHTML = encoded;
    return decoder.value;
  });
}

// CodeMirror can reuse a DOM node with a different, equal widget instance.
const imageCleanups = new WeakMap<HTMLElement, () => void>();

class ImageWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly from: number,
    private readonly src: string,
    private readonly alt: string,
    private readonly width: string,
    private readonly height: string,
  ) { super(); }

  eq(other: ImageWidget): boolean {
    return this.source === other.source && this.from === other.from
      && this.src === other.src;
  }

  updateDOM(surface: HTMLElement, view: EditorView, previous: ImageWidget): boolean {
    if (this.source !== previous.source || this.src !== previous.src) return false;
    // Position-only edits keep both loaded images and pending host reads alive.
    this.bindSourceSelection(surface, view);
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const surface = view.dom.ownerDocument.createElement("div");
    surface.className = CSS.imagePreview;
    const image = view.dom.ownerDocument.createElement("img");
    image.alt = this.alt;
    const src = decodedDestination(view.dom.ownerDocument, this.src);
    image.style.width = this.width;
    image.style.height = this.height;
    image.onload = () => view.requestMeasure();
    image.onerror = () => view.requestMeasure();
    surface.appendChild(image);
    let alive = true;
    let objectUrl: string | null = null;
    imageCleanups.set(surface, () => {
      alive = false;
      surface.onmousedown = null;
      image.onload = null;
      image.onerror = null;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    });
    const reader = view.state.facet(imageResourceFacet);
    if (src && isSafeUrl(src)) {
      if (reader) {
        // Never assign the source URL while waiting: that would issue a network
        // request before a local-file host has resolved the image.
        void (async () => {
          try {
            const blob = await reader(src);
            if (!alive) return;
            objectUrl = URL.createObjectURL(blob);
            const fragmentStart = src.indexOf("#");
            image.src = objectUrl + (fragmentStart < 0 ? "" : src.slice(fragmentStart));
          } catch (error) {
            if (!alive) return;
            image.title = `Could not load image: ${String(error)}`;
            view.requestMeasure();
          }
        })();
      } else {
        image.src = src;
      }
    }
    this.bindSourceSelection(surface, view);
    return surface;
  }

  private bindSourceSelection(surface: HTMLElement, view: EditorView): void {
    surface.onmousedown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      view.dispatch({ selection: EditorSelection.cursor(this.from), scrollIntoView: true });
      view.focus();
    };
  }

  destroy(dom: HTMLElement): void {
    imageCleanups.get(dom)?.();
    imageCleanups.delete(dom);
  }

  ignoreEvent(): boolean { return true; }
}

interface ImagePlan {
  readonly from: number;
  readonly to: number;
  readonly widget: ImageWidget;
}

interface ImageState {
  readonly plans: readonly ImagePlan[];
  readonly decorations: DecorationSet;
}

function imagePlans(state: EditorState): readonly ImagePlan[] {
  const tree = getPandocTree(state);
  const plans: ImagePlan[] = [];
  tree.iterate((node) => {
    if (node.kind === "PipeTable" || node.kind === "YamlMetadata") return false;
    if (!isBlockImage(node)) return;
    const destination = child(node, "LinkDestination");
    const src = destination
      ? destination.prop(destinationSyntax) === "angle" ? destination.text().slice(1, -1) : destination.text()
      : node.kind === "ImageReferenceCandidate" ? tree.semantics.reference(node).destination : "";
    if (src === null) return false;
    const brackets = [...node.children()].filter((value) => value.kind === "BracketMark");
    const alt = brackets.length >= 2 ? state.sliceDoc(brackets[0].to, brackets[1].from) : "";
    const dimensions: Record<string, string> = {};
    for (const attribute of child(node, "AttributeList")?.children() ?? []) {
      const name = child(attribute, "AttributeName")?.text();
      const value = child(attribute, "AttributeValue")?.text();
      if ((name === "width" || name === "height") && value) {
        const dimension = unquote(value);
        dimensions[name] = /^\d+(?:\.\d+)?$/.test(dimension) ? `${dimension}px` : dimension;
      }
    }
    const widget = new ImageWidget(node.text(), node.from, src, alt, dimensions.width ?? "", dimensions.height ?? "");
    plans.push({ from: node.from, to: node.to, widget });
    return false;
  });
  return plans;
}

function imageDecorations(state: EditorState, plans: readonly ImagePlan[]): ImageState {
  const ranges: Array<ReturnType<Decoration["range"]>> = [];
  for (const { from, to, widget } of plans) {
    const active = state.selection.ranges.some((range) => range.from <= to && range.to >= from);
    if (active) {
      ranges.push(Decoration.widget({ widget, block: true, side: -1 }).range(state.doc.lineAt(from).from));
      const last = state.doc.lineAt(to).number;
      for (let line = state.doc.lineAt(from).number; line <= last; line++) {
        ranges.push(Decoration.line({ class: CSS.imageSource }).range(state.doc.line(line).from));
      }
    } else {
      ranges.push(Decoration.replace({ widget, block: true }).range(from, to));
    }
  }
  return { plans, decorations: Decoration.set(ranges, true) };
}

export const cstImageDecorationField = StateField.define<ImageState>({
  create: (state) => imageDecorations(state, imagePlans(state)),
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.selection) return value;
    return imageDecorations(transaction.state,
      transaction.docChanged ? imagePlans(transaction.state) : value.plans);
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});
