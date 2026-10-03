'use client';

import { useCallback, useEffect, useState } from 'react';
import { t } from '@agentos/ui-foundation/i18n';
import {
  Button,
  EmptyState,
  KeyValueList,
  LoadingState,
  SectionHeader,
  StatusBadge,
} from '@agentos/ui-foundation/react';
import type {
  AiTeamDomain,
  CompanySkill,
  SkillHealthResponse,
  SkillTestResult,
} from '../../lib/types/tenant-console';
import { tenantConsoleClient } from '../../lib/tenant-console-client';

function skillName(skill: CompanySkill): string {
  const label = t(skill.display_key);
  return label === skill.display_key ? skill.skill_id : label;
}

function testLabel(outcome: SkillTestResult['outcome']): string {
  return t(`skills.test.${outcome}`);
}

export function AiTeamSkillsPanel({ domain }: { readonly domain: AiTeamDomain }) {
  const [skills, setSkills] = useState<readonly CompanySkill[]>([]);
  const [health, setHealth] = useState<Readonly<Record<string, SkillHealthResponse>>>({});
  const [results, setResults] = useState<Readonly<Record<string, SkillTestResult>>>({});
  const [draftAgents, setDraftAgents] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setFailed(false);
    void tenantConsoleClient.getSkills()
      .then(async (response) => {
        setSkills(response.skills);
        const settled = await Promise.allSettled(response.skills.map((skill) => tenantConsoleClient.getSkillHealth(skill.skill_id)));
        const next: Record<string, SkillHealthResponse> = {};
        settled.forEach((result, index) => {
          const skill = response.skills[index];
          if (skill !== undefined && result.status === 'fulfilled') next[skill.skill_id] = result.value;
        });
        setHealth(next);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = useCallback(async (skill: CompanySkill) => {
    setBusy(skill.skill_id);
    try {
      const updated = await tenantConsoleClient.updateSkillSettings(skill.skill_id, {
        enabled: !skill.enabled,
        config: skill.config,
        connector_id: skill.connector_id,
        version: skill.version,
      });
      setSkills((current) => current.map((entry) => (entry.skill_id === updated.skill_id ? updated : entry)));
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }, []);

  const runTest = useCallback(async (skill: CompanySkill) => {
    setBusy(skill.skill_id);
    try {
      const response = await tenantConsoleClient.testSkill(skill.skill_id);
      setResults((current) => ({ ...current, [skill.skill_id]: response.result }));
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }, []);

  const saveAgents = useCallback(async (skill: CompanySkill) => {
    const agents = draftAgents[skill.skill_id] ?? skill.assigned_agents;
    setBusy(skill.skill_id);
    try {
      const assigned = await tenantConsoleClient.setSkillAgents(skill.skill_id, agents);
      setSkills((current) => current.map((entry) => (entry.skill_id === skill.skill_id ? { ...entry, assigned_agents: assigned } : entry)));
      setSaved(skill.skill_id);
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }, [draftAgents]);

  if (loading) return <LoadingState label={t('common.loading')} />;

  const inDomain = skills.filter((skill) => skill.domain === domain);
  const visible = inDomain.length > 0 ? inDomain : skills;

  return (
    <div className="space-y-4">
      <SectionHeader title={t('aiTeam.tabs.skills')} description={t(`aiTeam.${domain}.purpose`)} />
      {failed ? <p role="alert" className="text-sm text-danger">{t('common.error')}</p> : null}
      {visible.length === 0
        ? <EmptyState title={t('skills.empty')} status="NO_DATA" />
        : visible.map((skill) => {
          const availability = skill.availability;
          const recent = results[skill.skill_id];
          const snapshot = health[skill.skill_id]?.health;
          const assignment = draftAgents[skill.skill_id] ?? skill.assigned_agents;
          return (
            <article key={skill.skill_id} className="ui-surface space-y-4 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-ink">{skillName(skill)}</h3>
                  <p className="mt-1 text-sm text-muted">
                    {t(`skills.reason.${availability.reason}`)}
                  </p>
                </div>
                <StatusBadge code={availability.available ? 'ENABLED' : 'DISABLED'} label={t(availability.available ? 'skills.available' : 'skills.unavailable')} />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={skill.enabled ? t('skills.disable') : t('skills.enable')}
                    checked={skill.enabled}
                    disabled={busy === skill.skill_id}
                    onChange={() => { void toggle(skill); }}
                  />
                  {skill.enabled ? t('skills.disable') : t('skills.enable')}
                </label>
                <Button size="sm" variant="secondary" loading={busy === skill.skill_id} onClick={() => { void runTest(skill); }}>
                  {t('skills.test')}
                </Button>
                {recent !== undefined ? (
                  <span className="text-sm text-muted">
                    {testLabel(recent.outcome)}{recent.latency_ms === null ? '' : ` · ${recent.latency_ms} ms`}
                  </span>
                ) : null}
              </div>

              {skill.allowed_agents.length > 0 ? (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium text-ink">{t('skills.agents.title')}</legend>
                  <div className="flex flex-wrap gap-3">
                    {skill.allowed_agents.map((agent) => (
                      <label key={agent} className="flex items-center gap-2 text-sm text-muted">
                        <input
                          type="checkbox"
                          checked={assignment.includes(agent)}
                          onChange={(event) => {
                            const next = event.target.checked
                              ? [...assignment, agent]
                              : assignment.filter((entry) => entry !== agent);
                            setDraftAgents((current) => ({ ...current, [skill.skill_id]: next }));
                          }}
                        />
                        {agent}
                      </label>
                    ))}
                  </div>
                  <Button size="sm" variant="secondary" loading={busy === skill.skill_id} onClick={() => { void saveAgents(skill); }}>
                    {saved === skill.skill_id ? t('skills.agents.saved') : t('skills.agents.save')}
                  </Button>
                </fieldset>
              ) : null}

              <div>
                <p className="text-sm font-medium text-ink">{t('skills.health.title')}</p>
                {snapshot === undefined
                  ? <p className="text-sm text-muted">{t('skills.health.no_data')}</p>
                  : (
                    <KeyValueList
                      items={[
                        { key: 'runs', label: t('skills.health.runs'), value: snapshot.success_count + snapshot.failure_count + snapshot.refusal_count + snapshot.awaiting_human_count },
                        { key: 'rate', label: t('skills.health.success_rate'), value: snapshot.success_rate === null ? null : `${Math.round(snapshot.success_rate * 100)}%` },
                        { key: 'latency', label: t('skills.health.latency'), value: snapshot.avg_latency_ms },
                      ]}
                    />
                  )}
              </div>
            </article>
          );
        })}
    </div>
  );
}
