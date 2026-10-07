// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell.js';
import { AuthLayout } from './AuthLayout.js';
import { Drawer } from './Drawer.js';
import { MobileNavDrawer } from './MobileNavDrawer.js';
import { Modal } from './Modal.js';
import { PageHeader } from './PageHeader.js';
import { Sidebar } from './Sidebar.js';
import { Tabs } from './Tabs.js';
import { Topbar } from './Topbar.js';

const items = [{ href: '/overview', label: 'Overview', active: true }];
afterEach(cleanup);

describe('layout components', () => {
  it('renders AppShell landmarks and a skip link', () => {
    render(
      <AppShell sidebar={<Sidebar items={items} />} topbar={<Topbar title="Overview" />}>
        <p>Content</p>
      </AppShell>,
    );

    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('navigation')).toBeTruthy();
    expect(screen.getByRole('main').getAttribute('id')).toBe('main-content');
    expect(screen.getByRole('link', { name: /bỏ qua|skip/i }).getAttribute('href')).toBe('#main-content');
  });

  it('traps focus in MobileNavDrawer, closes on Escape, and restores focus', () => {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.textContent = 'Open menu';
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const view = render(<MobileNavDrawer open onClose={onClose} items={items} />);

    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /đóng|close/i }));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(<MobileNavDrawer open={false} onClose={onClose} items={items} />);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('labels modal and drawer dialogs and closes each with Escape', () => {
    const onModalClose = vi.fn();
    const modal = render(
      <Modal open onClose={onModalClose} title="Confirm action" description="Review this action.">
        <p>Modal content</p>
      </Modal>,
    );
    const modalDialog = screen.getByRole('dialog', { name: 'Confirm action' });
    expect(modalDialog.getAttribute('aria-modal')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onModalClose).toHaveBeenCalledTimes(1);
    modal.unmount();

    const onDrawerClose = vi.fn();
    render(
      <Drawer open onClose={onDrawerClose} title="Details">
        <p>Drawer content</p>
      </Drawer>,
    );
    const drawerDialog = screen.getByRole('dialog', { name: 'Details' });
    expect(drawerDialog.getAttribute('aria-modal')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDrawerClose).toHaveBeenCalledTimes(1);
  });

  it('supports keyboard navigation between tabs', () => {
    render(
      <Tabs
        tabs={[
          { id: 'first', label: 'First', content: <p>First content</p> },
          { id: 'second', label: 'Second', content: <p>Second content</p> },
        ]}
      />,
    );
    const first = screen.getByRole('tab', { name: 'First' });
    const second = screen.getByRole('tab', { name: 'Second' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').textContent).toContain('Second content');
  });

  it('does not select tab 0 when controlled activeTabId is not in tabs list', () => {
    render(
      <Tabs
        activeTabId="non-existent"
        tabs={[
          { id: 'first', label: 'First', content: <p>First content</p> },
          { id: 'second', label: 'Second', content: <p>Second content</p> },
        ]}
      />,
    );
    expect(screen.queryByRole('tabpanel')).toBeNull();
    const first = screen.getByRole('tab', { name: 'First' });
    expect(first.getAttribute('aria-selected')).toBe('false');
  });

  it('renders an audience subtitle without a role selector', () => {
    render(
      <AuthLayout audience="company">
        <form aria-label="Sign in form"><input aria-label="Email" /></form>
      </AuthLayout>,
    );
    expect(screen.getByText('Company Workspace')).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('renders exactly one page h1', () => {
    render(<PageHeader title="Overview" description="Current activity" />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});
