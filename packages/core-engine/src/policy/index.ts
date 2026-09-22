/**
 * @file Barrel of the policy module: the authority gate and the enforcement point.
 *
 * `authority.ts` owns the total, dependency-free verdict rule; `PolicyEnforcementPoint.ts` owns the
 * injected pipeline that refuses an action before any queue row or reservation can exist.
 */

export * from './authority.js';
export * from './PolicyEnforcementPoint.js';
