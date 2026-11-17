import { Redirect, useLocalSearchParams } from 'expo-router';

/** `tappi://send/<username>` (a Receive QR code opened by the camera app): Send, filled in. */
export default function SendToLink() {
  const { handle } = useLocalSearchParams<{ handle: string }>();
  return <Redirect href={{ pathname: '/send', params: { to: handle.replace(/^@/, '').toLowerCase() } }} />;
}
