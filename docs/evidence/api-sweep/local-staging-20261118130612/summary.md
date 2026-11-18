# API sweep local-staging 20261118130612

Reads: 84 endpoints × 2 roles. Owner statuses {"200":56,"404":17,"409":1,"422":4,"500":6}; viewer {"200":47,"403":13,"404":15,"422":4,"500":5}.
Server errors (5xx): 6
- GET /v1/workspaces/<ws>/billing/portal: {"error":{"code":"internal","message":"Could not embed because more than one relationship was found for 'workspace_members' and 'users'","request_id":"df14d171-e05f-4179-8eec-223ffabc96ac"}}
- GET /v1/workspaces/<ws>/brands/<brand>/content: {"error":{"code":"internal","message":"Could not find a relationship between 'content_items' and 'content_versions' in the schema cache","request_id":"99ffdd7a-9318-4aa9-bd20-f5879ee473d0"}}
- GET /v1/workspaces/<ws>/jobs/00000000-0000-4000-8000-0000000000aa: {"error":{"code":"internal","message":"Cannot coerce the result to a single JSON object","request_id":"4777f65d-8437-44c5-9b39-234656b12588"}}
- GET /v1/workspaces/<ws>/media/00000000-0000-4000-8000-0000000000aa/url: {"error":{"code":"internal","message":"Cannot coerce the result to a single JSON object","request_id":"887b8027-6757-438a-8e59-645a48d74637"}}
- GET /v1/workspaces/<ws>/connected-accounts/00000000-0000-4000-8000-0000000000aa/wordpress-terms: {"error":{"code":"internal","message":"Cannot coerce the result to a single JSON object","request_id":"d8aa3761-e66c-4fd7-bf59-a729f15240c9"}}
- GET /v1/workspaces/<ws>/members: {"error":{"code":"internal","message":"Could not embed because more than one relationship was found for 'workspace_members' and 'users'","request_id":"05ea9b78-4f26-423f-936f-ba0010c7f6c9"}}

Writes: 11/16 as expected.
- campaign update: 422 {"error":{"code":"validation_failed","message":"Invalid request.","details":[{"path":"revision","message":"Invalid input: expected number, received undefined"}],"request_id":"c55125eb-3e06-40f9-9ff6-0
- submit for approval: 422 {"error":{"code":"validation_failed","message":"fix the checklist errors before submitting","request_id":"8c702797-d60e-4c85-885c-bb73393b2991"}}
- approval is listed: 404 null
- changes requested needs a comment: 0 null
- invite create: 402 {"error":{"code":"plan_limit","message":"Your plan allows 2 seats.","details":{"limit":"max_seats","max":2,"current":2},"request_id":"995463f4-d871-41f1-b294-e6d988bd5a54"}}
