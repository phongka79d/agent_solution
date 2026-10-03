/**
 * Platform operations console route (T8.3): Lượt chạy · Đối soát · Bị kẹt.
 */

import { OperationsConsole } from '../../../../components/operations/OperationsConsole';

export const metadata = {
  title: 'Vận hành | AgentOS Platform',
  description: 'Giám sát lượt chạy toàn nền tảng, đối soát kết quả không xác định và xử lý công việc bị kẹt.',
};

export default function OperationsPage() {
  return <OperationsConsole />;
}
