import { Link } from 'react-router-dom';
import { SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/page-states';

const NotFound = () => (
  <EmptyState icon={SearchX} className="min-h-dvh px-6" title="This page does not exist"
    action={<Button asChild variant="outline"><Link to="/">Go to the start page</Link></Button>} />
);

export default NotFound;
