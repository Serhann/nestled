import { useParams } from 'react-router';
import { useWebsiteSettings } from './WebsiteLayout';
import { InstallPanel } from './InstallPanel';

export default function Install() {
  const { websiteId = '' } = useParams();
  const { data } = useWebsiteSettings();
  return <InstallPanel websiteId={websiteId} publicKey={data.website.public_key} />;
}
