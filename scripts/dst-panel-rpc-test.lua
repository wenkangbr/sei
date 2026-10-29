local handler, received, moved, stopped, canMove, live = nil, nil, nil, false, true, true
local player = { GUID = 10, userid = 'KU_1', name = '玩家', prefab = 'wilson', IsValid = function() return true end, HasTag = function() return false end, Transform = { GetWorldPosition = function() return 3, 0, 5 end } }
local body = { components = { health = { IsDead = function() return false end }, locomotor = { Stop = function() stopped = true end } }, Transform = { SetPosition = function(_, x, y, z) moved = { x, y, z } end } }
local companion = { inst = body, IsLive = function() return live end }
local modules = { ['sei/version'] = 'test', ['sei/companion'] = companion, ['sei/events'] = { OnChat = function(...) received = {...} end } }
GLOBAL = { TheNet = { GetIsServer = function() return true end }, TheSim = {}, TheWorld = { Map = { IsPassableAtPoint = function() return canMove end } }, require = function(s) return assert(modules[s], s) end, json = {}, pcall = pcall, tostring = tostring, type = type, pairs = pairs, Networking_Say = function() end }
local env = { GLOBAL = GLOBAL, GetModConfigData = function() return false end, print = function() end, AddModRPCHandler = function(ns, name, fn) assert(ns == 'sei_panel' and name == 'action'); handler = fn end, AddSimPostInit = function() end }
assert(loadfile('native/dst-mod/sei/modmain.lua', 't', env))()
assert(handler)
handler(player, 'chat', '你好')
assert(received[2] == 'KU_1' and received[5] == '你好' and received[6] == true)
received = nil; handler(player, 'chat', string.rep('a', 513)); assert(received == nil)
handler(player, 'call', '')
assert(stopped and moved[1] == 3 and moved[3] == 5)
moved = nil; canMove = false; handler(player, 'call', ''); assert(moved == nil)
canMove = true; live = false; handler(player, 'call', ''); assert(moved == nil)
print('DST server panel RPC test passed')
