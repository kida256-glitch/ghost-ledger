// The DEMO.md judge walkthrough, end to end (dashboard-simulator D16).
// Runs in order against one freshly seeded demo group.
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";

test.describe.configure({ mode: "serial" });

const PASSWORD = process.env.DEMO_LEADER_PASSWORD_HINT ?? "tubeera-demo-2026";

/** Picks a demo member on the simulator and runs one session, step by step. */
async function dialSession(page: Page, member: string, steps: string[]): Promise<string> {
  await page.goto("/simulator");
  await page.getByRole("button", { name: new RegExp(member) }).click();
  await page.getByRole("button", { name: "Dial", exact: true }).click();
  const screen = page.getByTestId("phone-screen");
  await expect(screen).not.toHaveText("...");
  for (const step of steps) {
    const before = await screen.innerText();
    await page.getByLabel("Your reply").fill(step);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(screen).not.toHaveText(before);
    await expect(screen).not.toHaveText("...");
  }
  return screen.innerText();
}

async function signIn(page: Page, email: string) {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

function npmRun(script: string): string {
  return execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "--silent", script], { encoding: "utf8", shell: process.platform === "win32" });
}

test("1. Waiswa Henry's first dial sets his PIN", async ({ page }) => {
  expect(await dialSession(page, "Waiswa Henry", [])).toContain("Create a 4-digit PIN");
  expect(await dialSession(page, "Waiswa Henry", ["7391", "7391"])).toContain("PIN saved");
});

test("2. Waiswa Henry saves UGX 5,000 (deposit request)", async ({ page }) => {
  expect(await dialSession(page, "Waiswa Henry", ["7391", "1", "5000", "1"])).toContain("Request sent: UGX 5,000");
});

test("3. Nakato Sarah (chair) requests a loan", async ({ page }) => {
  expect(await dialSession(page, "Nakato Sarah", ["2580", "2", "50000", "1"])).toContain("Interest UGX 5,000");
  expect(await dialSession(page, "Nakato Sarah", ["2580", "2", "50000", "1", "1"])).toContain("Loan request sent");
});

test("4. the treasurer confirms the deposit and approves the chair's loan", async ({ page }) => {
  await signIn(page, "tubeera.treasurer@example.com");
  await expect(page.getByText("Chain verified")).toBeVisible();

  await page.goto("/dashboard/deposits");
  const card = page.locator("li", { hasText: "Waiswa Henry" }).filter({ hasText: "UGX 5,000" });
  await card.getByRole("button", { name: "Confirm deposit" }).click();
  await expect(page.getByTestId("toast")).toContainText("Deposit confirmed.");
  await page.reload();
  await expect(page.locator("li", { hasText: "Waiswa Henry" }).filter({ hasText: "UGX 5,000" })).toHaveCount(0);

  await page.goto("/dashboard/loans");
  const loan = page.getByTestId("loan-request").filter({ hasText: "Nakato Sarah" }).filter({ hasText: "UGX 50,000" });
  await loan.getByRole("button", { name: "Approve and pay out" }).click();
  await expect(page.getByTestId("toast")).toContainText("Loan approved and paid out.");
  await page.reload();
  await expect(page.locator("section", { hasText: "Active loans" }).getByText("Nakato Sarah")).toBeVisible();
});

test("5. the chain is verified, then a tamper makes it fail at that seq, and a restore fixes it", async ({ page }) => {
  await signIn(page, "tubeera.chair@example.com");
  await page.goto("/dashboard/ledger");
  await expect(page.getByText("Chain verified")).toBeVisible();

  const out = npmRun("demo:tamper");
  const seq = /seq (\d+)/.exec(out)?.[1];
  expect(seq).toBeDefined();
  await page.reload();
  await expect(page.getByText(`Chain failed at seq ${seq}`).first()).toBeVisible();

  npmRun("demo:restore");
  await page.reload();
  await expect(page.getByText("Chain verified")).toBeVisible();
});

test("6. the planted anomalies are listed", async ({ page }) => {
  await signIn(page, "tubeera.chair@example.com");
  await page.goto("/dashboard/alerts");
  await expect(page.getByText("Loan paid out with no approval")).toBeVisible();
  await expect(page.getByText("Loan above the savings limit")).toBeVisible();
});
