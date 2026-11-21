"use server";
// Dashboard server actions (D13). Each is a one-line wrapper around runAction,
// which authorizes on every call (D1.4); a source test checks this.
import { revalidatePath } from "next/cache";
import { formFields, runAction, type ActionKind, type ActionResult } from "./_lib/actions-core";
import { actionDeps } from "./_lib/server";

async function act(kind: ActionKind, form: FormData): Promise<ActionResult> {
  const r = await runAction(kind, formFields(form), actionDeps());
  if (r.ok) revalidatePath("/dashboard", "layout");
  return r;
}

export async function registerMemberAction(_prev: ActionResult | null, form: FormData) {
  return act("registerMember", form);
}
export async function confirmDepositAction(_prev: ActionResult | null, form: FormData) {
  return act("confirmDeposit", form);
}
export async function approveLoanAction(_prev: ActionResult | null, form: FormData) {
  return act("approveLoan", form);
}
export async function rejectLoanAction(_prev: ActionResult | null, form: FormData) {
  return act("rejectLoan", form);
}
export async function recordRepaymentAction(_prev: ActionResult | null, form: FormData) {
  return act("recordRepayment", form);
}
export async function recordSocialFundAction(_prev: ActionResult | null, form: FormData) {
  return act("recordSocialFund", form);
}
export async function reverseEntryAction(_prev: ActionResult | null, form: FormData) {
  return act("reverseEntry", form);
}
