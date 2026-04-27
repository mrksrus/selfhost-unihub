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
    expect(iframe).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    expect(iframe.getAttribute('srcdoc')).toContain('<base target="_blank" />');
    expect(iframe.getAttribute('srcdoc')).toContain('<body><h1>Hello</h1></body>');
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
