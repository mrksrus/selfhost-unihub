import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SafeEmailContent } from '@/components/mail/SafeEmailContent';

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));

describe('Dark email reading', () => {
  it('shows readable text without executing or requesting HTML content', () => {
    render(<SafeEmailContent emailId="a" bodyHtml={'<style>body{color:red}</style><script>alert(1)</script><p>Hello</p><img src="https://tracker.example/x" />'} bodyText={null} />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.queryByTitle('email-a')).not.toBeInTheDocument();
    expect(screen.queryByText('alert(1)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Original email appearance' }));
    expect(screen.getByTitle('email-a')).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    expect(screen.getByTitle('email-a').getAttribute('srcdoc')).toContain("img-src 'self' data: blob:");
    fireEvent.click(screen.getByRole('button', { name: 'Dark reading view' }));
    expect(screen.queryByTitle('email-a')).not.toBeInTheDocument();
  });

  it('keeps original appearance and remote content choices scoped to one message', () => {
    const body = '<img src="https://tracker.example/image" />';
    const view = render(<SafeEmailContent emailId="a" bodyHtml={body} bodyText="Mail A" />);
    fireEvent.click(screen.getByRole('button', { name: 'Original email appearance' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load remote content' }));
    view.rerender(<SafeEmailContent emailId="b" bodyHtml={body} bodyText="Mail B" />);
    expect(screen.getByText('Mail B')).toBeInTheDocument();
    expect(screen.queryByTitle('email-b')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Original email appearance' }));
    expect(screen.getByTitle('email-b').getAttribute('srcdoc')).not.toContain("img-src 'self' data: blob: http: https:");
  });
});
