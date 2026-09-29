## Default Permission

Default permissions for Froglight stylus accessories and semantic input policy. Accessory actions travel through a direct JavaScript hook; get_capabilities seeds state and set_input_context changes only the low-frequency host policy.

#### This default permission set includes the following:

- `allow-get-capabilities`
- `allow-set-input-context`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`froglight-stylus:allow-get-capabilities`

</td>
<td>

Enables the get_capabilities command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`froglight-stylus:deny-get-capabilities`

</td>
<td>

Denies the get_capabilities command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`froglight-stylus:allow-set-input-context`

</td>
<td>

Enables the set_input_context command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`froglight-stylus:deny-set-input-context`

</td>
<td>

Denies the set_input_context command without any pre-configured scope.

</td>
</tr>
</table>
