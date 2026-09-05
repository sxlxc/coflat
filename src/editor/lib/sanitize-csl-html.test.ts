import { describe, expect, it } from "vitest";
import { sanitizeCslHtml } from "./sanitize-csl-html";

describe("sanitizeCslHtml", () => {
  it("preserves CSL formatting and safe links", () => {
    const output = sanitizeCslHtml(
      '<span class="csl-entry"><i>Nature</i> <a href="https://doi.org/10.1/example">DOI</a></span>',
    );

    expect(output).toContain('<span class="csl-entry">');
    expect(output).toContain("<i>Nature</i>");
    expect(output).toContain('href="https://doi.org/10.1/example"');
  });

  it("removes executable elements and their content", () => {
    const output = sanitizeCslHtml(
      '<span>Title<script>alert(1)</script><style>body{display:none}</style></span>',
    );

    expect(output).not.toContain("script");
    expect(output).not.toContain("style");
    expect(output).not.toContain("alert(1)");
    expect(output).not.toContain("display:none");
  });

  it("removes event handlers and unsafe links", () => {
    const output = sanitizeCslHtml(
      '<a href="javascript:alert(1)" onclick="alert(2)">unsafe</a>',
    );

    expect(output).not.toContain("javascript:");
    expect(output).not.toContain("onclick");
    expect(output).toContain("unsafe");
  });
});
