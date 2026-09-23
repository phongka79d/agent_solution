/**
 * @file apps/command-center/src/app/(dashboard)/approvals/page.tsx
 * Command Center page hosting SCR-003: Approval Center and SCR-004: Customer 360.
 * Supports URL search params (`customer_id`, `customerId`, `tab`), tab navigation,
 * and direct cross-navigation from approval action payloads to customer timelines.
 */
'use client';

import React, { Suspense, useState, useEffect } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { ApprovalCenter } from '../../../components/approvals/ApprovalCenter';
import { Customer360Timeline } from '../../../components/customer/Customer360Timeline';

type ActiveTab = 'approvals' | 'customer';

function ApprovalsDashboardContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const customerIdParam = searchParams.get('customer_id') || searchParams.get('customerId') || '';
  const tabParam = searchParams.get('tab');

  const [activeTab, setActiveTab] = useState<ActiveTab>(() => {
    if (tabParam === 'customer' || (Boolean(customerIdParam) && tabParam !== 'approvals')) {
      return 'customer';
    }
    return 'approvals';
  });

  const [selectedCustomerId, setSelectedCustomerId] = useState<string>(customerIdParam);

  // Synchronize when URL searchParams change
  useEffect(() => {
    if (customerIdParam && customerIdParam !== selectedCustomerId) {
      setSelectedCustomerId(customerIdParam);
      if (tabParam !== 'approvals') {
        setActiveTab('customer');
      }
    }
  }, [customerIdParam, tabParam, selectedCustomerId]);

  const handleTabChange = (newTab: ActiveTab) => {
    setActiveTab(newTab);
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', newTab);
    if (newTab === 'customer' && selectedCustomerId) {
      params.set('customer_id', selectedCustomerId);
    }
    router.replace(`${pathname}?${params.toString()}`);
  };

  const handleSelectCustomer = (newCustomerId: string) => {
    setSelectedCustomerId(newCustomerId);
    setActiveTab('customer');
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', 'customer');
    params.set('customer_id', newCustomerId);
    router.replace(`${pathname}?${params.toString()}`);
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-6 lg:p-8">
      {/* View Switcher Tabs */}
      <div className="flex items-center gap-2 mb-6 border-b border-slate-800 pb-3 flex-wrap">
        <button
          type="button"
          onClick={() => handleTabChange('approvals')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
            activeTab === 'approvals'
              ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-950/40'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-850 border border-slate-800'
          }`}
        >
          SCR-003: Approval Center
        </button>

        <button
          type="button"
          onClick={() => handleTabChange('customer')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${
            activeTab === 'customer'
              ? 'bg-sky-500 text-slate-950 shadow-md shadow-sky-950/40'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-850 border border-slate-800'
          }`}
        >
          <span>SCR-004: Customer 360</span>
          {selectedCustomerId && (
            <span
              className={`px-1.5 py-0.2 rounded text-[10px] font-mono ${
                activeTab === 'customer' ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300'
              }`}
            >
              {selectedCustomerId}
            </span>
          )}
        </button>
      </div>

      {/* Screen Views */}
      {activeTab === 'approvals' ? (
        <ApprovalCenter onSelectCustomer={handleSelectCustomer} />
      ) : (
        <Customer360Timeline
          initialCustomerId={selectedCustomerId}
          onCustomerIdChange={(newId) => {
            setSelectedCustomerId(newId);
            const params = new URLSearchParams(searchParams.toString());
            params.set('customer_id', newId);
            params.set('tab', 'customer');
            router.replace(`${pathname}?${params.toString()}`);
          }}
        />
      )}
    </main>
  );
}

export default function ApprovalsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-950 text-slate-400 p-8 flex items-center justify-center font-mono text-xs">
          loading: Initializing governance and customer consoles…
        </div>
      }
    >
      <ApprovalsDashboardContent />
    </Suspense>
  );
}
