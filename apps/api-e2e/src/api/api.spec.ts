import axios from 'axios';

import { apiUrl } from '../support/config';

describe('api root', () => {
  it('serves a hello message on GET /api', async () => {
    const res = await axios.get(apiUrl('/'));
    expect(res.status).toBe(200);
    expect(res.data.message).toBeTruthy();
  });
});
