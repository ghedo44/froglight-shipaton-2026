## Default Permission

Default permissions for the Froglight external file-drop plugin. Drop events travel through a direct JavaScript hook with opaque tokens; read_drop_file resolves one token to bytes and release_drop_file drops it. No filesystem paths or content URIs ever reach shared application code.

#### This default permission set includes the following:

- `allow-read-drop-file`
- `allow-release-drop-file`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`froglight-file-drop:allow-read-drop-file`

</td>
<td>

Enables the read_drop_file command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`froglight-file-drop:deny-read-drop-file`

</td>
<td>

Denies the read_drop_file command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`froglight-file-drop:allow-release-drop-file`

</td>
<td>

Enables the release_drop_file command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`froglight-file-drop:deny-release-drop-file`

</td>
<td>

Denies the release_drop_file command without any pre-configured scope.

</td>
</tr>
</table>
