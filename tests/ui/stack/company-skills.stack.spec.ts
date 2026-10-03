import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { assertRouteQuality, openConsole } from './helpers';

test('company toggles and assigns a skill, runs its test, and sees health', async ({ page }) => {
  await openConsole(page, 'company');
  await page.goto('/ai-team/sales/skills');
  const cards = page.locator('article');
  await expect(cards.first()).toBeVisible({ timeout: 60_000 });
  await assertRouteQuality(page);

  let targetIndex = -1;
  let assignmentIndex = -1;
  let assignmentWasChecked = false;
  for (let cardIndex = 0; cardIndex < await cards.count(); cardIndex += 1) {
    const card = cards.nth(cardIndex);
    const agents = card.locator('fieldset input[type="checkbox"]');
    const agentCount = await agents.count();
    if (agentCount < 2) continue;

    let checkedCount = 0;
    let uncheckedIndex = -1;
    for (let agentIndex = 0; agentIndex < agentCount; agentIndex += 1) {
      if (await agents.nth(agentIndex).isChecked()) checkedCount += 1;
      else if (uncheckedIndex < 0) uncheckedIndex = agentIndex;
    }
    if (uncheckedIndex >= 0) {
      targetIndex = cardIndex;
      assignmentIndex = uncheckedIndex;
      assignmentWasChecked = false;
      break;
    }
    if (checkedCount > 1) {
      targetIndex = cardIndex;
      assignmentIndex = 0;
      assignmentWasChecked = true;
      break;
    }
  }
  expect(targetIndex, 'the Sales catalog must include a skill whose assignment can change without removing every allowed agent').toBeGreaterThanOrEqual(0);

  const card = cards.nth(targetIndex);
  const toggle = card.getByRole('switch');
  const initiallyEnabled = await toggle.isChecked();
  const agents = card.locator('fieldset input[type="checkbox"]');
  const assignment: Locator = agents.nth(assignmentIndex);
  const saveAssignment = card.locator('fieldset').getByRole('button');

  try {
    await toggle.click();
    await expect(toggle).toBeChecked({ checked: !initiallyEnabled });
    await toggle.click();
    await expect(toggle).toBeChecked({ checked: initiallyEnabled });

    await assignment.click();
    await saveAssignment.click();
    await expect(saveAssignment).toHaveText('Đã lưu phân công');
    await expect(assignment).toBeChecked({ checked: !assignmentWasChecked });
    await assignment.click();
    await saveAssignment.click();
    await expect(saveAssignment).toHaveText('Đã lưu phân công');
    await expect(assignment).toBeChecked({ checked: assignmentWasChecked });

    await card.getByRole('button', { name: 'Chạy thử', exact: true }).click();
    await expect(card.getByText(/(?:Đạt|Không đạt|Bị từ chối)(?: · \d+ ms)?/)).toBeVisible({ timeout: 120_000 });
    await expect(card.getByText('Sức khỏe 24 giờ', { exact: true })).toBeVisible();
    await expect(card.getByText(/Lượt chạy|Chưa có dữ liệu 24 giờ/)).toBeVisible();
    await assertRouteQuality(page);
  } finally {
    if (await toggle.isChecked() !== initiallyEnabled) {
      await toggle.click();
      await expect(toggle).toBeChecked({ checked: initiallyEnabled });
    }
    if (await assignment.isChecked() !== assignmentWasChecked) {
      await assignment.click();
      await saveAssignment.click();
      await expect(assignment).toBeChecked({ checked: assignmentWasChecked });
    }
  }
});
