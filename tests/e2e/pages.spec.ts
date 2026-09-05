import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const documents = [
  { id: "showcase", name: "Showcase", path: "../../examples/simple/showcase.md" },
  { id: "format", name: "Format guide", path: "../../FORMAT.md" },
  { id: "example", name: "Example", path: "../../examples/simple/example.md" },
];

for (const document of documents) {
  test(`demo loads ${document.name} from its direct link`, async ({ page }) => {
    await page.goto(`/examples/simple/?doc=${document.id}`);
    await expect(page.locator("#editor .cm-editor")).toBeVisible();
    await expect(page.locator("[data-doc-id][aria-current]")).toHaveText(document.name);
    await page.getByRole("button", { name: "View source" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await page.locator("#document-source").textContent()).toBe(
      readFileSync(new URL(document.path, import.meta.url), "utf8"),
    );
  });
}

test("demo switches all three documents from the keyboard", async ({ page }) => {
  await page.goto("/examples/simple/");
  await expect(page.locator("[data-doc-id][aria-current]")).toHaveText("Showcase");

  for (const document of [documents[2], documents[1], documents[0]]) {
    const link = page.getByRole("link", { name: document.name, exact: true });
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`\\?doc=${document.id}$`));
    await expect(page.locator("[data-doc-id][aria-current]")).toHaveText(document.name);
    await expect(page.locator("#editor .cm-content")).toBeFocused();
    await page.getByRole("button", { name: "View source" }).click();
    expect(await page.locator("#document-source").textContent()).toBe(
      readFileSync(new URL(document.path, import.meta.url), "utf8"),
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
  }
});
