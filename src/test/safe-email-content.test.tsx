import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SafeEmailContent } from '@/components/mail/SafeEmailContent';

describe('SafeEmailContent', () => {
  it('renders HTML content in a sandboxed iframe', () => {
    render(
      <SafeEmailContent
        emailId="email-1"
        bodyHtml="<h1>Hello</h1>"
        bodyText={null}
      />
    );

    const iframe = screen.getByTitle('email-email-1');
    expect(iframe).toBeInTheDocument();
    expect(iframe).toHaveAttribute('sandbox');
    expect(iframe).toHaveAttribute('srcdoc', '<h1>Hello</h1>');
  });

  it('falls back to plain text when HTML is unavailable', () => {
    render(
      <SafeEmailContent
        emailId="email-2"
        bodyHtml={null}
        bodyText="Plain body"
      />
    );

    expect(screen.getByText('Plain body')).toBeInTheDocument();
  });
});
