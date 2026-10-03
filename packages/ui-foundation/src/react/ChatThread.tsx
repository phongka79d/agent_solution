import type { Key, ReactNode } from 'react';
import { t } from '../i18n/index.js';

export type ChatThreadSpeaker = 'customer' | 'assistant' | 'staff' | 'system';

export interface ChatThreadMessage {
  readonly id: Key;
  readonly speaker: ChatThreadSpeaker;
  readonly label: ReactNode;
  readonly content: ReactNode;
  readonly time?: ReactNode;
}

export interface ChatThreadProps {
  readonly messages: readonly ChatThreadMessage[];
  readonly label?: string;
  readonly emptyLabel?: ReactNode;
  readonly className?: string;
}

export function ChatThread({ messages, label, emptyLabel, className }: ChatThreadProps) {
  return (
    <ol
      className={['ui-chat-thread', className].filter(Boolean).join(' ')}
      role="log"
      aria-label={label ?? t('chat.thread.label')}
      aria-relevant="additions text"
    >
      {messages.length === 0 ? (
        <li className="ui-chat-thread__empty">{emptyLabel ?? t('common.empty')}</li>
      ) : messages.map((message) => (
        <li key={message.id} className={`ui-chat-thread__message ui-chat-thread__message--${message.speaker}`}>
          <div className="ui-chat-thread__speaker">{message.label}</div>
          <div className="ui-chat-thread__content">{message.content}</div>
          {message.time === undefined ? null : <div className="ui-chat-thread__time">{message.time}</div>}
        </li>
      ))}
    </ol>
  );
}
