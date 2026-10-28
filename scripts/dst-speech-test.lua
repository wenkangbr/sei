local seen
TheNet = { Announce = function(_, text) seen = text end }
local Speak = dofile('native/dst-mod/sei/scripts/sei/speak.lua')
local bot = { name = '伙伴', IsValid = function() return true end, components = { talker = { Say = function(_, text) seen = text end } } }
local text = string.rep('好', 54)
assert(Speak.Say(bot, text, false))
assert(seen == string.rep('好', 53))
print('DST speech UTF-8 test passed')
